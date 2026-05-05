import { describe, expect, it } from "vitest";
import type { Accounts } from "../src/config.js";
import {
  buildRule,
  diagnoseXError,
  parseStreamPayload,
  shouldHandleTweet,
} from "../src/sources/filtered-stream.js";
import type { Tweet } from "../src/sources/tweet-source.js";

function makeTweet(overrides: Partial<Tweet> = {}): Tweet {
  return {
    id: "1",
    authorHandle: "elonmusk",
    authorId: "u1",
    text: "hello",
    createdAt: new Date("2026-05-01T12:00:00Z"),
    images: [],
    isReply: false,
    isRetweet: false,
    isQuoteTweet: false,
    ...overrides,
  };
}

describe("buildRule", () => {
  it("combines accounts with OR", () => {
    const accounts: Accounts = {
      accounts: [{ handle: "elonmusk" }, { handle: "sama" }, { handle: "saro" }],
    };
    expect(buildRule(accounts)).toBe("from:elonmusk OR from:sama OR from:saro");
  });

  it("truncates from the end when rule exceeds 1024 bytes", () => {
    const accounts: Accounts = {
      accounts: Array.from({ length: 200 }, (_, i) => ({
        handle: `user${String(i).padStart(4, "0")}`,
      })),
    };
    const rule = buildRule(accounts);
    expect(Buffer.byteLength(rule, "utf8")).toBeLessThanOrEqual(1024);
    expect(rule).toMatch(/^from:user0000/); // first survives
  });

  it("returns a single-account rule cleanly", () => {
    const accounts: Accounts = { accounts: [{ handle: "elonmusk" }] };
    expect(buildRule(accounts)).toBe("from:elonmusk");
  });
});

describe("parseStreamPayload", () => {
  it("returns null for missing fields", () => {
    // biome-ignore lint/suspicious/noExplicitAny: testing malformed payload
    expect(parseStreamPayload({} as any)).toBeNull();
    // biome-ignore lint/suspicious/noExplicitAny: testing malformed payload
    expect(parseStreamPayload({ data: { id: "x" } } as any)).toBeNull();
  });

  it("parses a basic tweet with an image", () => {
    const payload = {
      data: {
        id: "1234",
        author_id: "u1",
        text: "doge to the moon",
        created_at: "2026-05-01T12:00:00Z",
        attachments: { media_keys: ["m1"] },
      },
      includes: {
        users: [{ id: "u1", username: "elonmusk" }],
        media: [{ media_key: "m1", type: "photo", url: "https://pbs.twimg.com/media/img.jpg" }],
      },
    };
    // biome-ignore lint/suspicious/noExplicitAny: x-api types are noisy
    const tweet = parseStreamPayload(payload as any);
    expect(tweet).not.toBeNull();
    expect(tweet?.authorHandle).toBe("elonmusk");
    expect(tweet?.images).toHaveLength(1);
    expect(tweet?.images[0]?.url).toBe("https://pbs.twimg.com/media/img.jpg");
    expect(tweet?.isRetweet).toBe(false);
    expect(tweet?.isReply).toBe(false);
  });

  it("flags reply / retweet / quote", () => {
    const payload = {
      data: {
        id: "1",
        author_id: "u1",
        text: "x",
        created_at: "2026-05-01T12:00:00Z",
        referenced_tweets: [{ type: "replied_to", id: "p" }],
      },
      includes: { users: [{ id: "u1", username: "el" }] },
    };
    // biome-ignore lint/suspicious/noExplicitAny: x-api types
    expect(parseStreamPayload(payload as any)?.isReply).toBe(true);

    const rt = {
      ...payload,
      data: { ...payload.data, referenced_tweets: [{ type: "retweeted", id: "p" }] },
    };
    // biome-ignore lint/suspicious/noExplicitAny: x-api types
    expect(parseStreamPayload(rt as any)?.isRetweet).toBe(true);
  });

  it("expands a quote-tweet into tweet.quotedTweet", () => {
    const payload = {
      data: {
        id: "1",
        author_id: "u1",
        text: "lol look at this",
        created_at: "2026-05-01T12:00:00Z",
        referenced_tweets: [{ type: "quoted", id: "q1" }],
      },
      includes: {
        users: [
          { id: "u1", username: "elonmusk" },
          { id: "u2", username: "sama" },
        ],
        tweets: [
          {
            id: "q1",
            author_id: "u2",
            text: "ai is going to be huge",
            created_at: "2026-04-30T08:00:00Z",
          },
        ],
      },
    };
    // biome-ignore lint/suspicious/noExplicitAny: x-api types
    const tweet = parseStreamPayload(payload as any);
    expect(tweet?.isQuoteTweet).toBe(true);
    expect(tweet?.quotedTweet).toBeDefined();
    expect(tweet?.quotedTweet?.id).toBe("q1");
    expect(tweet?.quotedTweet?.authorHandle).toBe("sama");
    expect(tweet?.quotedTweet?.text).toBe("ai is going to be huge");
    expect(tweet?.quotedTweet?.createdAt.toISOString()).toBe("2026-04-30T08:00:00.000Z");
    expect(tweet?.quotedTweet?.isQuoteTweet).toBe(false);
    expect(tweet?.quotedTweet?.images).toEqual([]);
  });

  it("expands photo media from quoted tweets", () => {
    const payload = {
      data: {
        id: "1",
        author_id: "u1",
        text: "this happens before launch",
        created_at: "2026-05-01T12:00:00Z",
        referenced_tweets: [{ type: "quoted", id: "q1" }],
      },
      includes: {
        users: [
          { id: "u1", username: "founder" },
          { id: "u2", username: "news" },
        ],
        tweets: [
          {
            id: "q1",
            author_id: "u2",
            text: "quoted news with portrait",
            created_at: "2026-04-30T08:00:00Z",
            attachments: { media_keys: ["qm1", "qv1"] },
          },
        ],
        media: [
          {
            media_key: "qm1",
            type: "photo",
            url: "https://pbs.twimg.com/media/quoted.jpg",
          },
          {
            media_key: "qv1",
            type: "video",
            preview_image_url: "https://pbs.twimg.com/media/preview.jpg",
          },
        ],
      },
    };
    // biome-ignore lint/suspicious/noExplicitAny: x-api types
    const tweet = parseStreamPayload(payload as any);
    expect(tweet?.images).toEqual([]);
    expect(tweet?.quotedTweet?.images).toEqual([{ url: "https://pbs.twimg.com/media/quoted.jpg" }]);
  });

  it("flags quote without populating quotedTweet when includes is missing the quoted tweet", () => {
    const payload = {
      data: {
        id: "1",
        author_id: "u1",
        text: "x",
        created_at: "2026-05-01T12:00:00Z",
        referenced_tweets: [{ type: "quoted", id: "missing" }],
      },
      includes: { users: [{ id: "u1", username: "el" }] },
    };
    // biome-ignore lint/suspicious/noExplicitAny: x-api types
    const tweet = parseStreamPayload(payload as any);
    expect(tweet?.isQuoteTweet).toBe(true);
    expect(tweet?.quotedTweet).toBeUndefined();
  });

  it("ignores video media (only photos are launchable)", () => {
    const payload = {
      data: {
        id: "1",
        author_id: "u1",
        text: "x",
        created_at: "2026-05-01T12:00:00Z",
        attachments: { media_keys: ["v1"] },
      },
      includes: {
        users: [{ id: "u1", username: "el" }],
        media: [{ media_key: "v1", type: "video", preview_image_url: "https://x.com/preview.jpg" }],
      },
    };
    // biome-ignore lint/suspicious/noExplicitAny: x-api types
    const tweet = parseStreamPayload(payload as any);
    expect(tweet?.images).toHaveLength(0);
  });
});

describe("shouldHandleTweet", () => {
  const ignoreBefore = new Date("2026-05-01T00:00:00Z").getTime();

  it("handles a fresh, eligible tweet", () => {
    expect(shouldHandleTweet(makeTweet(), { ignoreBefore })).toEqual({ handle: true });
  });

  it("rejects tweets older than ignoreBefore", () => {
    const stale = makeTweet({ createdAt: new Date("2026-04-30T23:59:59Z") });
    expect(shouldHandleTweet(stale, { ignoreBefore })).toEqual({
      handle: false,
      reason: "stale",
    });
  });

  it("treats createdAt exactly at ignoreBefore as fresh", () => {
    const onBoundary = makeTweet({ createdAt: new Date(ignoreBefore) });
    expect(shouldHandleTweet(onBoundary, { ignoreBefore })).toEqual({ handle: true });
  });

  it("rejects authors not in followedHandles when post-filtering is on", () => {
    const followedHandles = new Set(["elonmusk", "sama"]);
    const other = makeTweet({ authorHandle: "stranger" });
    expect(shouldHandleTweet(other, { ignoreBefore, followedHandles })).toEqual({
      handle: false,
      reason: "not_followed",
    });
  });

  it("matches followedHandles case-insensitively", () => {
    const followedHandles = new Set(["elonmusk"]);
    const tweet = makeTweet({ authorHandle: "ElonMusk" });
    expect(shouldHandleTweet(tweet, { ignoreBefore, followedHandles })).toEqual({ handle: true });
  });

  it("does not post-filter when followedHandles is undefined", () => {
    const tweet = makeTweet({ authorHandle: "stranger" });
    expect(shouldHandleTweet(tweet, { ignoreBefore })).toEqual({ handle: true });
  });

  it("rejects pure retweets but allows quote tweets", () => {
    const retweet = makeTweet({ isRetweet: true });
    expect(shouldHandleTweet(retweet, { ignoreBefore })).toEqual({
      handle: false,
      reason: "retweet",
    });

    const quote = makeTweet({ isRetweet: true, isQuoteTweet: true });
    expect(shouldHandleTweet(quote, { ignoreBefore })).toEqual({ handle: true });
  });

  it("rejects replies", () => {
    const reply = makeTweet({ isReply: true });
    expect(shouldHandleTweet(reply, { ignoreBefore })).toEqual({
      handle: false,
      reason: "reply",
    });
  });

  it("checks rejection reasons in order: stale > not_followed > retweet > reply", () => {
    // A tweet that fails every filter should report `stale` (the first check).
    const followedHandles = new Set(["only-this-one"]);
    const failsEverything = makeTweet({
      createdAt: new Date(ignoreBefore - 1),
      authorHandle: "stranger",
      isRetweet: true,
      isReply: true,
    });
    expect(shouldHandleTweet(failsEverything, { ignoreBefore, followedHandles })).toEqual({
      handle: false,
      reason: "stale",
    });
  });
});

describe("diagnoseXError", () => {
  it("explains 401/403 as auth or Filtered Stream entitlement", () => {
    expect(diagnoseXError(401)).toMatch(/Auth failure/);
    expect(diagnoseXError(401)).toMatch(/Filtered Stream/);
    expect(diagnoseXError(403)).toMatch(/Auth failure/);
  });

  it("explains 429 as rate-limit", () => {
    expect(diagnoseXError(429)).toMatch(/Rate-limited/);
  });

  it("explains 503 as outage or missing entitlement", () => {
    const msg = diagnoseXError(503);
    expect(msg).toMatch(/503/);
    expect(msg).toMatch(/Filtered Stream/);
  });

  it("explains 404 as Filtered Stream not enabled", () => {
    expect(diagnoseXError(404)).toMatch(/not enabled/);
  });

  it("falls back to a generic hint for unknown / undefined codes", () => {
    expect(diagnoseXError(undefined)).toMatch(/Unexpected error from X/);
    expect(diagnoseXError(500)).toMatch(/Unexpected error from X/);
    expect(diagnoseXError(418)).toMatch(/Unexpected error from X/);
  });
});
