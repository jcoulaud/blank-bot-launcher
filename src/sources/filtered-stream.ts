import { ETwitterStreamEvent, type TweetV2SingleStreamResult, TwitterApi } from "twitter-api-v2";
import type { Accounts } from "../config.js";
import { getLogger } from "../logger.js";
import { errMsg } from "../util/errors.js";
import { ALLOWED_IMAGE_HOSTS } from "../util/x-hosts.js";
import type { Tweet, TweetHandler, TweetMedia, TweetSource } from "./tweet-source.js";

const X_RULE_MAX_BYTES = 1024;
const RULE_TAG = "blank-bot-followed";
const log = getLogger({ pipeline_stage: "stream" });

export type FilteredStreamOptions = {
  bearerToken: string;
  accounts: Accounts;
  /** Unix timestamp in milliseconds. Older tweets are dropped on startup. */
  ignoreBefore: number;
  /**
   * Called when `handler(tweet)` rejects after the pipeline's internal
   * try/catches. Lets the caller record the tweet as skipped so the bot
   * doesn't reprocess it after a restart.
   */
  onPipelineError?: (tweet: Tweet, err: unknown) => void;
};

export class FilteredStreamSource implements TweetSource {
  private client: TwitterApi;
  private stream?: Awaited<ReturnType<TwitterApi["v2"]["searchStream"]>>;
  private stopping = false;
  // True when other rules exist on the project; in that case we post-filter
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
      let tweet: Tweet | null;
      try {
        tweet = parseStreamPayload(payload);
      } catch (err) {
        log.error({ err: errMsg(err) }, "stream parser threw");
        return;
      }
      if (!tweet) {
        // Distinguish empty heartbeats (no `data`) from genuinely malformed
        // payloads. Silent drops are how the bot stops processing if X
        // changes their schema.
        if ((payload as { data?: unknown })?.data) {
          log.warn(
            { preview: JSON.stringify(payload).slice(0, 200) },
            "stream payload has data but parser rejected it",
          );
        } else {
          log.debug("stream heartbeat / non-tweet payload");
        }
        return;
      }
      const decision = shouldHandleTweet(tweet, {
        ignoreBefore: this.options.ignoreBefore,
        ...(this.handleOnlyOurAccounts ? { followedHandles: this.followedHandles } : {}),
      });
      if (!decision.handle) {
        log.debug(
          { tweet_id: tweet.id, author: tweet.authorHandle, reason: decision.reason },
          "skipping tweet",
        );
        return;
      }
      try {
        await handler(tweet);
      } catch (err) {
        // The pipeline catches per-stage errors and records them itself.
        // Reaching here means a bug or a DB write failure. Record the tweet
        // as `skipped_error` so the bot doesn't loop on it across restarts.
        log.error(
          { err: errMsg(err), tweet_id: tweet.id, author_handle: tweet.authorHandle },
          "pipeline handler threw (recording as skipped_error)",
        );
        this.options.onPipelineError?.(tweet, err);
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

export type ShouldHandleOptions = {
  /** Unix timestamp in milliseconds. Tweets created before this are dropped. */
  ignoreBefore: number;
  /**
   * Lowercased handles we are following. When set, tweets from other handles
   * are dropped (used when other rules share the X project). Leave undefined
   * when only our rule is installed and post-filtering isn't needed.
   */
  followedHandles?: ReadonlySet<string>;
};

export type ShouldHandleDecision =
  | { handle: true }
  | { handle: false; reason: "stale" | "not_followed" | "retweet" | "reply" };

/**
 * Pure post-parse filter. Mirrors the rejection rules the stream handler
 * applies to a parsed tweet, in order:
 *   stale -> not_followed -> retweet -> reply.
 */
export function shouldHandleTweet(tweet: Tweet, opts: ShouldHandleOptions): ShouldHandleDecision {
  if (tweet.createdAt.getTime() < opts.ignoreBefore) {
    return { handle: false, reason: "stale" };
  }
  if (opts.followedHandles && !opts.followedHandles.has(tweet.authorHandle.toLowerCase())) {
    return { handle: false, reason: "not_followed" };
  }
  if (tweet.isRetweet && !tweet.isQuoteTweet) {
    return { handle: false, reason: "retweet" };
  }
  if (tweet.isReply) {
    return { handle: false, reason: "reply" };
  }
  return { handle: true };
}

/**
 * Accepts both the streaming payload (`TweetV2SingleStreamResult`) and the
 * `client.v2.singleTweet()` response: both expose `data` and `includes` with
 * the same shape, so the parser is shared. Typed as the structural subset
 * we actually read so callers don't have to cast through `as never`.
 */
export type StreamPayloadLike = {
  data: TweetV2SingleStreamResult["data"];
  includes?: TweetV2SingleStreamResult["includes"] | undefined;
};

export function parseStreamPayload(payload: StreamPayloadLike): Tweet | null {
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
  for (const key of mediaKeys) {
    const m = includes?.media?.find((mm) => mm.media_key === key);
    if (!m) continue;
    if (m.type === "photo" && m.url && isAllowedImageUrl(m.url)) {
      images.push({ url: m.url });
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
    const causeMsg = errMsg(cause);
    const code = extractStatusCode(cause);
    const tip = diagnoseXError(code);
    super(
      `Failed to start X Filtered Stream (${causeMsg}).\n${tip}\n` +
        `Verify at https://developer.x.com > your project > Keys & Tokens / Subscriptions.`,
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

export function diagnoseXError(code: number | undefined): string {
  if (code === 401 || code === 403) {
    return "Auth failure: Bearer Token is wrong, or your X app/project does not have Filtered Stream access. Most common: free tier excludes Filtered Stream; attach billing for pay-per-use, or upgrade plan.";
  }
  if (code === 429) {
    return "Rate-limited by X. Wait a few minutes and retry, or check the Subscriptions tab for your monthly cap.";
  }
  if (code === 503) {
    return "X returned 503. Either a transient outage (retry in a few minutes) OR your project lacks Filtered Stream entitlement (the API returns 503 instead of 403 in this case). Check developer.x.com > Subscriptions: pay-per-use needs billing attached; legacy Free tier does not include Filtered Stream.";
  }
  if (code === 404) {
    return "X returned 404; usually means Filtered Stream is not enabled on this project.";
  }
  return "Unexpected error from X. Check developer.x.com Subscriptions and that the bearer token belongs to a project with Filtered Stream enabled.";
}

function isAllowedImageUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    return ALLOWED_IMAGE_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}
