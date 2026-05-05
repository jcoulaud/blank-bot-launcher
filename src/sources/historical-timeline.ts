import { type TweetV2, TwitterApi } from "twitter-api-v2";
import type { Accounts } from "../config.js";
import { getLogger } from "../logger.js";
import { errMsg } from "../util/errors.js";
import {
  type XApiUsageRecorder,
  xApiReadResourcesFromPayload,
  xApiUserReadResources,
} from "../util/x-api-cost.js";
import { parseStreamPayload, type StreamPayloadLike } from "./filtered-stream.js";
import type { Tweet, TweetHandler, TweetSource } from "./tweet-source.js";

const log = getLogger({ pipeline_stage: "backtest-source" });
const USER_LOOKUP_BATCH_SIZE = 100;
const X_TIMELINE_PAGE_MAX = 100;
const X_TIMELINE_PAGE_MIN = 5;

export type HistoricalTimelineOptions = {
  bearerToken: string;
  accounts: Accounts;
  perAccountLimit: number;
  onPipelineError?: (tweet: Tweet, err: unknown) => void;
  onUsage?: XApiUsageRecorder;
};

type TimelinePaginatorPage = {
  data: {
    includes?: StreamPayloadLike["includes"];
  };
};

type TimelinePaginator = {
  fetchAndIterate(): AsyncGenerator<[TweetV2, TimelinePaginatorPage], void, undefined>;
};

type TimelineClient = {
  usersByUsernames(
    usernames: string[],
    options?: unknown,
  ): Promise<{ data?: Array<{ id: string; username: string }>; errors?: unknown[] }>;
  userTimeline(userId: string, options?: unknown): Promise<TimelinePaginator>;
};

type XLookupErrorSummary = {
  x_error_title?: string;
  x_error_detail?: string;
  x_error_value?: string;
  x_error_reason?: string;
  x_error_type?: string;
};

export class HistoricalTimelineSource implements TweetSource {
  private readonly client: TimelineClient;
  private stopping = false;

  constructor(private readonly options: HistoricalTimelineOptions) {
    this.client = new TwitterApi(options.bearerToken).v2 as unknown as TimelineClient;
  }

  async start(handler: TweetHandler): Promise<void> {
    const handles = this.options.accounts.accounts.map((a) => a.handle);
    log.info(
      { accounts: handles.length, per_account_limit: this.options.perAccountLimit },
      "fetching historical account timelines",
    );

    const users = await this.resolveUsers(handles);
    const tweetsById = new Map<string, Tweet>();

    for (const user of users) {
      if (this.stopping) break;
      const tweets = await this.fetchUserTweets(user.id, user.username);
      for (const tweet of tweets) tweetsById.set(tweet.id, tweet);
      log.info({ author_handle: user.username, fetched: tweets.length }, "timeline fetched");
    }

    const tweets = sortTweetsForBacktest([...tweetsById.values()]);
    log.info({ tweets: tweets.length }, "historical fetch complete");

    for (const tweet of tweets) {
      if (this.stopping) break;
      try {
        await handler(tweet);
      } catch (err) {
        log.error(
          { err: errMsg(err), tweet_id: tweet.id, author_handle: tweet.authorHandle },
          "pipeline handler threw during backtest",
        );
        this.options.onPipelineError?.(tweet, err);
      }
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
  }

  private async resolveUsers(handles: string[]): Promise<Array<{ id: string; username: string }>> {
    const resolved: Array<{ id: string; username: string }> = [];
    for (const batch of chunk(handles, USER_LOOKUP_BATCH_SIZE)) {
      const lookup = await this.client.usersByUsernames(batch, { "user.fields": ["username"] });
      this.options.onUsage?.(xApiUserReadResources(lookup.data ?? []), "historical_user_lookup");
      const byLower = new Map((lookup.data ?? []).map((u) => [u.username.toLowerCase(), u]));
      for (const handle of batch) {
        const user = byLower.get(handle.toLowerCase());
        if (user) {
          resolved.push({ id: user.id, username: user.username });
        } else {
          log.warn(
            { handle, ...describeLookupErrorForHandle(handle, lookup.errors ?? []) },
            "configured account could not be resolved by X user lookup",
          );
        }
      }
    }
    return resolved;
  }

  private async fetchUserTweets(userId: string, handle: string): Promise<Tweet[]> {
    const limit = this.options.perAccountLimit;
    const paginator = await this.client.userTimeline(userId, {
      max_results: timelinePageSize(limit),
      exclude: ["retweets", "replies"],
      "tweet.fields": ["author_id", "created_at", "attachments", "referenced_tweets"],
      expansions: [
        "author_id",
        "attachments.media_keys",
        "referenced_tweets.id",
        "referenced_tweets.id.author_id",
      ],
      "media.fields": ["url", "type", "preview_image_url"],
      "user.fields": ["username"],
    });

    const tweets: Tweet[] = [];
    // Note: limit is on *eligible* tweets after filtering retweets/replies.
    // The paginator may have already pre-fetched another page by the time we
    // break, so a single backtest run can cost more than ceil(limit/page) X
    // API calls. Keep limit small if you're sensitive to X rate caps.
    for await (const [data, page] of paginator.fetchAndIterate()) {
      this.options.onUsage?.(
        xApiReadResourcesFromPayload({ data, includes: page.data.includes }),
        "historical_timeline",
      );
      const tweet = parseTimelineTweet(data, page.data.includes);
      if (!tweet) {
        log.warn({ tweet_id: data.id, author_handle: handle }, "timeline tweet could not parse");
        continue;
      }
      // The API-side `exclude` does the main filtering. Keep the same runtime
      // guard as the filtered stream so backtests match live intake.
      if (tweet.isRetweet && !tweet.isQuoteTweet) continue;
      if (tweet.isReply) continue;
      tweets.push(tweet);
      if (tweets.length >= limit) break;
    }
    return tweets;
  }
}

export function parseTimelineTweet(
  data: TweetV2,
  includes: StreamPayloadLike["includes"] | undefined,
): Tweet | null {
  return parseStreamPayload({ data, includes });
}

export function timelinePageSize(limit: number): number {
  return Math.min(X_TIMELINE_PAGE_MAX, Math.max(X_TIMELINE_PAGE_MIN, limit));
}

export function sortTweetsForBacktest(tweets: Tweet[]): Tweet[] {
  return [...tweets].sort((a, b) => {
    const createdDiff = a.createdAt.getTime() - b.createdAt.getTime();
    if (createdDiff !== 0) return createdDiff;
    return a.id.localeCompare(b.id);
  });
}

export function describeLookupErrorForHandle(
  handle: string,
  errors: unknown[],
): XLookupErrorSummary {
  const normalized = handle.toLowerCase();
  const match = errors
    .map(toLookupErrorRecord)
    .find((error) =>
      [error.value, error.detail, error.resource_id]
        .filter((field): field is string => typeof field === "string")
        .some((field) => field.toLowerCase().includes(normalized)),
    );
  const fallback = match ?? errors.map(toLookupErrorRecord).find(Boolean);
  if (!fallback) return {};
  return compactLookupErrorSummary({
    x_error_title: stringField(fallback.title),
    x_error_detail: stringField(fallback.detail),
    x_error_value: stringField(fallback.value),
    x_error_reason: stringField(fallback.reason),
    x_error_type: stringField(fallback.type),
  });
}

function toLookupErrorRecord(error: unknown): Record<string, unknown> {
  return error && typeof error === "object" ? (error as Record<string, unknown>) : {};
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function compactLookupErrorSummary(
  summary: Partial<Record<keyof XLookupErrorSummary, string | undefined>>,
): XLookupErrorSummary {
  const compact: XLookupErrorSummary = {};
  for (const [key, value] of Object.entries(summary)) {
    if (typeof value === "string" && value.length > 0) {
      compact[key as keyof XLookupErrorSummary] = value;
    }
  }
  return compact;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}
