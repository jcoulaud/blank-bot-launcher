import { describe, expect, it } from "vitest";
import type { Accounts } from "../src/config.js";
import { buildRule, parseStreamPayload } from "../src/sources/filtered-stream.js";

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
        media: [{ media_key: "m1", type: "photo", url: "https://x.com/img.jpg" }],
      },
    };
    // biome-ignore lint/suspicious/noExplicitAny: x-api types are noisy
    const tweet = parseStreamPayload(payload as any);
    expect(tweet).not.toBeNull();
    expect(tweet?.authorHandle).toBe("elonmusk");
    expect(tweet?.images).toHaveLength(1);
    expect(tweet?.images[0]?.url).toBe("https://x.com/img.jpg");
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

  it("captures video preview but no images", () => {
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
    expect(tweet?.videoUrl).toBe("https://x.com/preview.jpg");
  });
});
