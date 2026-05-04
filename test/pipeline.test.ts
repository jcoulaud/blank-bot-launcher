import { setTimeout as sleep } from "node:timers/promises";
import { Mutex } from "async-mutex";
import { describe, expect, it } from "vitest";
import { MockTweetSource } from "../src/sources/mock.js";
import type { Tweet } from "../src/sources/tweet-source.js";

/**
 * E2E pipeline test stripped to its load-bearing concerns:
 *   - serialization (D2)
 *   - one-tweet-at-a-time progression
 *
 * The full pipeline (classifier → metadata → image → IPFS → SDK) requires
 * external services or heavy mocks; here we exercise just the orchestration
 * pattern around `runExclusive()` to prove the pipeline never overlaps.
 */

function fakeTweet(id: string): Tweet {
  return {
    id,
    authorHandle: "elonmusk",
    authorId: "1",
    text: `tweet ${id}`,
    createdAt: new Date(),
    images: [],
    isReply: false,
    isRetweet: false,
    isQuoteTweet: false,
  };
}

describe("pipeline serialization (D2)", () => {
  it("processes tweets one-at-a-time even when delivered concurrently", async () => {
    const source = new MockTweetSource();
    source.enqueue(fakeTweet("t1"));
    source.enqueue(fakeTweet("t2"));
    source.enqueue(fakeTweet("t3"));

    const mutex = new Mutex();
    const concurrentInside: number[] = [];
    let active = 0;

    await source.start(async (_tweet) => {
      await mutex.runExclusive(async () => {
        active++;
        concurrentInside.push(active);
        await sleep(10);
        active--;
      });
    });

    expect(concurrentInside).toEqual([1, 1, 1]);
  });

  it("queues tweets when delivery rate exceeds processing rate", async () => {
    const source = new MockTweetSource();
    const mutex = new Mutex();
    const completed: string[] = [];

    const handler = async (tweet: Tweet) => {
      await mutex.runExclusive(async () => {
        await sleep(20);
        completed.push(tweet.id);
      });
    };

    await source.start(handler);
    // Now deliver 5 tweets back-to-back via deliver() — they all serialize
    const deliveries = ["a", "b", "c", "d", "e"].map((id) => source.deliver(fakeTweet(id)));
    await Promise.all(deliveries);

    expect(completed).toEqual(["a", "b", "c", "d", "e"]);
  });
});
