import { ETwitterStreamEvent, type TweetV2SingleStreamResult, TwitterApi } from "twitter-api-v2";
import type { Accounts } from "../config.js";
import { getLogger } from "../logger.js";
import type { Tweet, TweetHandler, TweetMedia, TweetSource } from "./tweet-source.js";

const X_RULE_MAX_BYTES = 1024;
const RULE_TAG = "blank-bot-followed";
const log = getLogger({ pipeline_stage: "stream" });

export type FilteredStreamOptions = {
  bearerToken: string;
  accounts: Accounts;
  /** ms epoch — tweets older than this are dropped on startup */
  ignoreBefore: number;
};

export class FilteredStreamSource implements TweetSource {
  private client: TwitterApi;
  private stream?: Awaited<ReturnType<TwitterApi["v2"]["searchStream"]>>;
  private stopping = false;
  // True when other (non-bot) rules exist on the project — we then post-filter
  // delivered tweets to only our followed handles.
  private handleOnlyOurAccounts = false;
  private followedHandles: Set<string>;

  constructor(private readonly options: FilteredStreamOptions) {
    this.client = new TwitterApi(options.bearerToken);
    this.followedHandles = new Set(options.accounts.accounts.map((a) => a.handle.toLowerCase()));
  }

  async start(handler: TweetHandler): Promise<void> {
    const rule = buildRule(this.options.accounts);
    log.info(
      {
        rule_bytes: Buffer.byteLength(rule, "utf8"),
        accounts: this.options.accounts.accounts.length,
      },
      "configuring filtered stream",
    );

    try {
      // Reconcile only rules we own (tag === RULE_TAG). Leaves other apps'
      // rules on the same project untouched.
      const current = await this.client.v2.streamRules();
      const existing = current.data ?? [];
      const ours = existing.filter((r) => r.tag === RULE_TAG);
      const others = existing.filter((r) => r.tag !== RULE_TAG);

      const alreadyCorrect = ours.length === 1 && ours[0]?.value === rule;
      if (alreadyCorrect) {
        log.info({ other_rules_left_alone: others.length }, "rule already up to date, no change");
      } else {
        if (ours.length > 0) {
          await this.client.v2.updateStreamRules({
            delete: { ids: ours.map((r) => r.id) },
          });
        }
        await this.client.v2.updateStreamRules({
          add: [{ value: rule, tag: RULE_TAG }],
        });
        log.info(
          {
            replaced: ours.length,
            other_rules_left_alone: others.length,
          },
          "rule installed",
        );
      }

      // The Filtered Stream is project-wide and delivers tweets matching ANY
      // rule on the project, including ones we didn't install. We only forward
      // tweets that match our rule's accounts.
      this.handleOnlyOurAccounts = others.length > 0;

      this.stream = await this.client.v2.searchStream({
        "tweet.fields": ["author_id", "created_at", "attachments", "referenced_tweets"],
        expansions: ["author_id", "attachments.media_keys", "referenced_tweets.id"],
        "media.fields": ["url", "type", "preview_image_url"],
        "user.fields": ["username"],
      });
    } catch (err) {
      throw new XStreamAccessError(err);
    }

    this.stream.autoReconnect = true;
    this.stream.autoReconnectRetries = Number.POSITIVE_INFINITY;

    this.stream.on(ETwitterStreamEvent.Data, async (payload) => {
      if (this.stopping) return;
      try {
        const tweet = parseStreamPayload(payload);
        if (!tweet) return;
        if (tweet.createdAt.getTime() < this.options.ignoreBefore) {
          log.debug({ tweet_id: tweet.id }, "skipping stale tweet");
          return;
        }
        // If other rules co-exist on the project, the stream may deliver tweets
        // matched by them (not us). Post-filter to our followed handles.
        if (
          this.handleOnlyOurAccounts &&
          !this.followedHandles.has(tweet.authorHandle.toLowerCase())
        ) {
          log.debug(
            { tweet_id: tweet.id, author: tweet.authorHandle },
            "not in our followed list (other rule matched)",
          );
          return;
        }
        if (tweet.isRetweet && !tweet.isQuoteTweet) {
          log.debug({ tweet_id: tweet.id }, "skipping pure retweet");
          return;
        }
        if (tweet.isReply) {
          log.debug({ tweet_id: tweet.id }, "skipping reply");
          return;
        }
        await handler(tweet);
      } catch (err) {
        log.error(
          { err: err instanceof Error ? err.message : String(err) },
          "error processing tweet",
        );
      }
    });

    this.stream.on(ETwitterStreamEvent.ConnectionError, (err) => {
      log.error({ err: err.message }, "stream connection error");
    });
    this.stream.on(ETwitterStreamEvent.ConnectionClosed, () => {
      log.warn("stream connection closed");
    });
    this.stream.on(ETwitterStreamEvent.Reconnected, () => {
      log.info("stream reconnected");
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.stream?.close();
  }
}

export function buildRule(accounts: Accounts): string {
  const parts = accounts.accounts.map((a) => `from:${a.handle}`);
  let rule = parts.join(" OR ");
  if (Buffer.byteLength(rule, "utf8") > X_RULE_MAX_BYTES) {
    // Truncate from the end to fit. Keeps highest-priority (first-listed) accounts.
    const trimmed: string[] = [];
    let used = 0;
    for (const part of parts) {
      const add = (trimmed.length === 0 ? 0 : 4) + Buffer.byteLength(part, "utf8");
      if (used + add > X_RULE_MAX_BYTES) break;
      trimmed.push(part);
      used += add;
    }
    rule = trimmed.join(" OR ");
    log.warn(
      { kept: trimmed.length, dropped: accounts.accounts.length - trimmed.length },
      "rule exceeded 1024 bytes, dropped trailing accounts",
    );
  }
  return rule;
}

export function parseStreamPayload(payload: TweetV2SingleStreamResult): Tweet | null {
  const data = payload.data;
  if (!data?.id || !data.author_id || !data.created_at) return null;

  const includes = payload.includes;
  const author = includes?.users?.find((u) => u.id === data.author_id);
  if (!author) return null;

  const refs = data.referenced_tweets ?? [];
  const isReply = refs.some((r) => r.type === "replied_to");
  const isRetweet = refs.some((r) => r.type === "retweeted");
  const isQuoteTweet = refs.some((r) => r.type === "quoted");

  const mediaKeys = data.attachments?.media_keys ?? [];
  const images: TweetMedia[] = [];
  let videoUrl: string | undefined;
  for (const key of mediaKeys) {
    const m = includes?.media?.find((mm) => mm.media_key === key);
    if (!m) continue;
    if (m.type === "photo" && m.url) {
      images.push({ url: m.url, mimeType: guessMimeFromUrl(m.url) });
    } else if (m.type === "video" || m.type === "animated_gif") {
      videoUrl = m.preview_image_url;
    }
  }

  let quotedTweet: Tweet | undefined;
  const quotedRef = refs.find((r) => r.type === "quoted");
  if (quotedRef && includes?.tweets) {
    const q = includes.tweets.find((t) => t.id === quotedRef.id);
    const qAuthor = q ? includes.users?.find((u) => u.id === q.author_id) : undefined;
    if (q && qAuthor && q.created_at) {
      quotedTweet = {
        id: q.id,
        authorHandle: qAuthor.username,
        authorId: q.author_id ?? "",
        text: q.text,
        createdAt: new Date(q.created_at),
        images: [], // not expanded recursively
        isReply: false,
        isRetweet: false,
        isQuoteTweet: false,
      };
    }
  }

  const tweet: Tweet = {
    id: data.id,
    authorHandle: author.username,
    authorId: data.author_id,
    text: data.text,
    createdAt: new Date(data.created_at),
    images,
    isReply,
    isRetweet,
    isQuoteTweet,
  };
  if (videoUrl) tweet.videoUrl = videoUrl;
  if (quotedTweet) tweet.quotedTweet = quotedTweet;
  return tweet;
}

/**
 * Wraps any error from the X Filtered Stream setup with a hint at the most
 * common cause (missing access tier / billing). 4xx auth issues, 5xx outages,
 * and 429 rate limits all share the same shape: the bot can't proceed.
 */
class XStreamAccessError extends Error {
  override readonly name = "XStreamAccessError";
  constructor(cause: unknown) {
    const causeMsg = cause instanceof Error ? cause.message : String(cause);
    const code = extractStatusCode(cause);
    const tip = diagnoseXError(code);
    super(
      `Failed to start X Filtered Stream (${causeMsg}).\n${tip}\n` +
        `Verify at https://developer.x.com → your project → Keys & Tokens / Subscriptions.`,
    );
  }
}

function extractStatusCode(err: unknown): number | undefined {
  if (err && typeof err === "object") {
    // twitter-api-v2 errors expose `code` on ApiResponseError
    const maybe = err as { code?: number; status?: number };
    return maybe.code ?? maybe.status;
  }
  return undefined;
}

function diagnoseXError(code: number | undefined): string {
  if (code === 401 || code === 403) {
    return "Auth failure: Bearer Token is wrong, or your X app/project does not have Filtered Stream access. Most common: free tier excludes Filtered Stream — attach billing for pay-per-use, or upgrade plan.";
  }
  if (code === 429) {
    return "Rate-limited by X. Wait a few minutes and retry, or check the Subscriptions tab for your monthly cap.";
  }
  if (code === 503) {
    return "X returned 503. Either a transient outage (retry in a few minutes) OR your project lacks Filtered Stream entitlement (the API returns 503 instead of 403 in this case). Check developer.x.com → Subscriptions: pay-per-use needs billing attached; legacy Free tier does not include Filtered Stream.";
  }
  if (code === 404) {
    return "X returned 404 — usually means Filtered Stream is not enabled on this project.";
  }
  return "Unexpected error from X. Check developer.x.com Subscriptions and that the bearer token belongs to a project with Filtered Stream enabled.";
}

function guessMimeFromUrl(url: string): string {
  const lower = url.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}
