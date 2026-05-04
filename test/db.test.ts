import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isoDateUtc, Store } from "../src/store/db.js";

describe("Store", () => {
  let tmp: string;
  let store: Store;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "blank-bot-test-"));
    store = new Store(join(tmp, "test.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("applies migrations on a fresh DB", () => {
    expect(store.recentSeen(10)).toEqual([]);
    expect(store.recentLaunches(10)).toEqual([]);
  });

  it("records and reads seen tweets", () => {
    store.recordSeen({
      tweet_id: "t1",
      author_handle: "elonmusk",
      seen_at: 1_700_000_000_000,
      classifier_score: 0.9,
      decision: "launched",
      reason: "memeable",
    });
    expect(store.hasSeen("t1")).toBe(true);
    expect(store.hasSeen("t2")).toBe(false);
    const seen = store.recentSeen(10);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.tweet_id).toBe("t1");
  });

  it("creates a fresh daily counter at 0/0", () => {
    const c = store.getDailyCounter(1_700_000_000_000);
    expect(c.launches_count).toBe(0);
    expect(c.sol_spent).toBe(0);
    expect(c.date).toBe(isoDateUtc(1_700_000_000_000));
  });

  it("recordLaunch increments daily counter atomically", () => {
    const t = 1_700_000_000_000;
    store.recordLaunch({
      mint: "M1",
      ticker: "DOGE",
      name: "Dogey",
      source_tweet_id: "t1",
      source_author: "elonmusk",
      sol_spent: 0.05,
      tx_signature: "sig1",
      metadata_uri: "ipfs://meta",
      image_cid: "img",
      launched_at: t,
      ai_reasoning: "reason",
    });
    const c = store.getDailyCounter(t);
    expect(c.launches_count).toBe(1);
    expect(c.sol_spent).toBeCloseTo(0.05);
  });

  it("lastLaunchByAuthor returns the most recent", () => {
    const base = 1_700_000_000_000;
    for (let i = 0; i < 3; i++) {
      store.recordLaunch({
        mint: `M${i}`,
        ticker: `T${i}`,
        name: `n${i}`,
        source_tweet_id: `t${i}`,
        source_author: "elonmusk",
        sol_spent: 0.01,
        tx_signature: `sig${i}`,
        metadata_uri: "ipfs://x",
        image_cid: "img",
        launched_at: base + i * 1000,
        ai_reasoning: null,
      });
    }
    const last = store.lastLaunchByAuthor("elonmusk");
    expect(last?.mint).toBe("M2");
    expect(store.lastLaunchByAuthor("nobody")).toBeNull();
  });
});
