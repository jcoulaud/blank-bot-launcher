import { describe, expect, it } from "vitest";
import {
  describeLookupErrorForHandle,
  parseTimelineTweet,
  sortTweetsForBacktest,
  timelinePageSize,
} from "../src/sources/historical-timeline.js";
import type { Tweet } from "../src/sources/tweet-source.js";

describe("timelinePageSize", () => {
  it("stays inside X timeline page bounds", () => {
    expect(timelinePageSize(1)).toBe(5);
    expect(timelinePageSize(50)).toBe(50);
    expect(timelinePageSize(500)).toBe(100);
  });
});

describe("parseTimelineTweet", () => {
  it("maps a user timeline tweet into the bot Tweet shape", () => {
    const tweet = parseTimelineTweet(
      {
        id: "123",
        text: "send it",
        author_id: "u1",
        created_at: "2026-05-01T12:00:00Z",
        edit_history_tweet_ids: ["123"],
      },
      { users: [{ id: "u1", username: "sama", name: "Sam Altman" }] },
    );

    expect(tweet?.id).toBe("123");
    expect(tweet?.authorHandle).toBe("sama");
    expect(tweet?.createdAt.toISOString()).toBe("2026-05-01T12:00:00.000Z");
    expect(tweet?.isReply).toBe(false);
  });
});

describe("sortTweetsForBacktest", () => {
  it("orders tweets oldest-first with id as a stable tie-breaker", () => {
    const base: Tweet = {
      id: "b",
      authorHandle: "sama",
      authorId: "u1",
      text: "b",
      createdAt: new Date("2026-05-01T12:00:00Z"),
      media: [],
      images: [],
      isReply: false,
      isRetweet: false,
      isQuoteTweet: false,
    };
    const sorted = sortTweetsForBacktest([
      base,
      { ...base, id: "c", createdAt: new Date("2026-05-02T12:00:00Z") },
      { ...base, id: "a" },
    ]);
    expect(sorted.map((t) => t.id)).toEqual(["a", "b", "c"]);
  });
});

describe("describeLookupErrorForHandle", () => {
  it("returns the X lookup detail that matches the missing handle", () => {
    const summary = describeLookupErrorForHandle("saro", [
      {
        value: "saro",
        title: "Not Found Error",
        detail: "Could not find user with usernames: [saro].",
        type: "https://api.x.com/problems/resource-not-found",
      },
    ]);

    expect(summary.x_error_title).toBe("Not Found Error");
    expect(summary.x_error_detail).toMatch(/saro/);
    expect(summary.x_error_value).toBe("saro");
  });
});
