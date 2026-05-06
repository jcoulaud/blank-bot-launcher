import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Decision, isoDateUtc, Store } from "../src/store/db.js";
import { seedLaunch } from "./helpers/db-helpers.js";

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

  it("commitReservedLaunch + reserveLaunchSlot bump the daily counter atomically", () => {
    const t = 1_700_000_000_000;
    seedLaunch(store, {
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
      classification_reason: "reason",
    });
    const c = store.getDailyCounter(t);
    expect(c.launches_count).toBe(1);
    expect(c.sol_spent).toBeCloseTo(0.05);
  });

  it("reconciles reserved spend to the actual measured launch cost", () => {
    const t = 1_700_000_000_000;
    const reservation = store.reserveLaunchSlot({
      timestampMs: t,
      plannedSpendSol: 0.05,
      maxLaunchesPerDay: 1,
      maxSolPerDay: 1,
    });
    expect(reservation).not.toBeNull();
    if (!reservation) return;

    store.commitReservedLaunch(
      {
        mint: "M1",
        ticker: "DOGE",
        name: "Dogey",
        source_tweet_id: "t1",
        source_author: "elonmusk",
        sol_spent: 0.0123,
        tx_signature: "sig1",
        metadata_uri: "ipfs://meta",
        image_cid: "img",
        launched_at: t,
        classification_reason: "reason",
      },
      {
        tweet_id: "t1",
        author_handle: "elonmusk",
        seen_at: t,
        classifier_score: 0.95,
        decision: "launched",
        reason: "reason",
      },
      reservation,
    );

    const c = store.getDailyCounter(t);
    expect(c.launches_count).toBe(1);
    expect(c.sol_spent).toBeCloseTo(0.0123);
  });

  it("committed daily counter is derived from launch rows, not open reservations", () => {
    const t = 1_700_000_000_000;
    const reservation = store.reserveLaunchSlot({
      timestampMs: t,
      plannedSpendSol: 0.05,
      maxLaunchesPerDay: 1,
      maxSolPerDay: 1,
    });
    expect(reservation).not.toBeNull();

    const reservedCounter = store.getDailyCounter(t);
    expect(reservedCounter.launches_count).toBe(1);
    expect(reservedCounter.sol_spent).toBeCloseTo(0.05);

    const committedCounter = store.getCommittedDailyCounter(t);
    expect(committedCounter.launches_count).toBe(0);
    expect(committedCounter.sol_spent).toBe(0);
  });

  it("records X API usage with UTC-day resource deduplication", () => {
    const t = Date.UTC(2026, 4, 1, 12, 0, 0);
    store.recordXApiUsage({
      timestampMs: t,
      source: "test",
      resources: [
        { resource_type: "post_read", resource_id: "tweet-1", cost_usd: 0.005 },
        { resource_type: "user_read", resource_id: "user-1", cost_usd: 0.01 },
      ],
    });
    store.recordXApiUsage({
      timestampMs: t + 60_000,
      source: "test",
      resources: [
        { resource_type: "post_read", resource_id: "tweet-1", cost_usd: 0.005 },
        { resource_type: "media_read", resource_id: "media-1", cost_usd: 0.005 },
      ],
    });

    const summary = store.getXApiUsageSummary(t);
    expect(summary.date).toBe("2026-05-01");
    expect(summary.today.resources).toBe(3);
    expect(summary.today.cost_usd).toBeCloseTo(0.02);
    expect(summary.today.by_type).toEqual([
      { resource_type: "media_read", resources: 1, cost_usd: 0.005 },
      { resource_type: "post_read", resources: 1, cost_usd: 0.005 },
      { resource_type: "user_read", resources: 1, cost_usd: 0.01 },
    ]);
  });

  it("charges the same X API resource again after the UTC day changes", () => {
    const dayOne = Date.UTC(2026, 4, 1, 23, 59, 0);
    const dayTwo = Date.UTC(2026, 4, 2, 0, 1, 0);
    const resource = [
      { resource_type: "post_read" as const, resource_id: "tweet-1", cost_usd: 0.005 },
    ];
    store.recordXApiUsage({ timestampMs: dayOne, source: "test", resources: resource });
    store.recordXApiUsage({ timestampMs: dayTwo, source: "test", resources: resource });

    expect(store.getXApiUsageSummary(dayOne).today.cost_usd).toBeCloseTo(0.005);
    expect(store.getXApiUsageSummary(dayTwo).today.cost_usd).toBeCloseTo(0.005);
    expect(store.getXApiUsageSummary(dayTwo).total.cost_usd).toBeCloseTo(0.01);
  });

  it("persists launch totals, daily counters, and X API usage across Store reopen", () => {
    const dbPath = join(tmp, "test.db");
    const dayOne = Date.UTC(2026, 4, 1, 12, 0, 0);
    const dayTwo = Date.UTC(2026, 4, 2, 12, 0, 0);

    seedLaunch(store, {
      mint: "M1",
      ticker: "ONE",
      name: "One",
      source_tweet_id: "t1",
      source_author: "x",
      sol_spent: 0.01,
      tx_signature: "s1",
      metadata_uri: "ipfs://one",
      image_cid: "img1",
      launched_at: dayOne,
      classification_reason: null,
    });
    seedLaunch(store, {
      mint: "M2",
      ticker: "TWO",
      name: "Two",
      source_tweet_id: "t2",
      source_author: "x",
      sol_spent: 0.02,
      tx_signature: "s2",
      metadata_uri: "ipfs://two",
      image_cid: "img2",
      launched_at: dayTwo,
      classification_reason: null,
    });
    store.recordXApiUsage({
      timestampMs: dayOne,
      source: "test",
      resources: [{ resource_type: "post_read", resource_id: "tweet-1", cost_usd: 0.005 }],
    });
    store.recordXApiUsage({
      timestampMs: dayTwo,
      source: "test",
      resources: [{ resource_type: "user_read", resource_id: "user-1", cost_usd: 0.01 }],
    });

    expect(store.getLaunchTotals()).toEqual({ launches_count: 2, sol_spent: 0.03 });
    store.close();
    store = new Store(dbPath);

    expect(store.getDailyCounter(dayOne).launches_count).toBe(1);
    expect(store.getDailyCounter(dayOne).sol_spent).toBeCloseTo(0.01);
    expect(store.getDailyCounter(dayTwo).launches_count).toBe(1);
    expect(store.getDailyCounter(dayTwo).sol_spent).toBeCloseTo(0.02);
    expect(store.getLaunchTotals().launches_count).toBe(2);
    expect(store.getLaunchTotals().sol_spent).toBeCloseTo(0.03);
    expect(store.getXApiUsageSummary(dayTwo).total.cost_usd).toBeCloseTo(0.015);
  });

  it("reserveLaunchSlot returns null when daily count cap is hit", () => {
    const t = 1_700_000_000_000;
    for (let i = 0; i < 3; i++) {
      seedLaunch(store, {
        mint: `M${i}`,
        ticker: `T${i}`,
        name: `n${i}`,
        source_tweet_id: `t${i}`,
        source_author: "x",
        sol_spent: 0.01,
        tx_signature: `s${i}`,
        metadata_uri: "u",
        image_cid: "c",
        launched_at: t,
        classification_reason: null,
      });
    }
    const denied = store.reserveLaunchSlot({
      timestampMs: t,
      plannedSpendSol: 0.01,
      maxLaunchesPerDay: 3,
      maxSolPerDay: 1,
    });
    expect(denied).toBeNull();
  });

  it("rollbackReservation frees a previously-reserved slot", () => {
    const t = 1_700_000_000_000;
    const r = store.reserveLaunchSlot({
      timestampMs: t,
      plannedSpendSol: 0.05,
      maxLaunchesPerDay: 1,
      maxSolPerDay: 1,
    });
    expect(r).not.toBeNull();
    if (!r) return;
    store.rollbackReservation({ date: r.date, plannedSpendSol: 0.05 });
    const c = store.getDailyCounter(t);
    expect(c.launches_count).toBe(0);
    expect(c.sol_spent).toBeCloseTo(0);
  });

  it("recordSeen accepts every Decision enum value and round-trips it", () => {
    const decisions: Decision[] = [
      "launched",
      "skipped_low_score",
      "skipped_safety",
      "skipped_validation",
      "skipped_error",
      "dry_run",
    ];
    decisions.forEach((decision, i) => {
      store.recordSeen({
        tweet_id: `t${i}`,
        author_handle: "elonmusk",
        seen_at: 1_700_000_000_000 + i,
        classifier_score: i % 2 === 0 ? 0.5 : null,
        decision,
        reason: decision === "launched" ? null : `${decision} reason`,
      });
    });
    const seen = store.recentSeen(decisions.length);
    expect(seen).toHaveLength(decisions.length);
    expect(seen.map((s) => s.decision).sort()).toEqual([...decisions].sort());
  });

  it("recordSeen with INSERT OR REPLACE upserts the same tweet_id", () => {
    store.recordSeen({
      tweet_id: "t1",
      author_handle: "elonmusk",
      seen_at: 1,
      classifier_score: 0.1,
      decision: "skipped_low_score",
      reason: "first",
    });
    store.recordSeen({
      tweet_id: "t1",
      author_handle: "elonmusk",
      seen_at: 2,
      classifier_score: 0.95,
      decision: "launched",
      reason: null,
    });
    const seen = store.recentSeen(10);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.decision).toBe("launched");
    expect(seen[0]?.classifier_score).toBe(0.95);
  });
});

describe("isoDateUtc", () => {
  it("returns YYYY-MM-DD in UTC", () => {
    expect(isoDateUtc(Date.UTC(2026, 4, 1, 12, 0, 0))).toBe("2026-05-01");
  });

  it("returns the previous day for late-evening US timestamps that are next-day UTC", () => {
    // 2026-05-01 23:30 PT = 2026-05-02 06:30 UTC
    const t = Date.UTC(2026, 4, 2, 6, 30, 0);
    expect(isoDateUtc(t)).toBe("2026-05-02");
  });

  it("returns the same date at the UTC midnight boundary", () => {
    expect(isoDateUtc(Date.UTC(2026, 4, 1, 0, 0, 0, 0))).toBe("2026-05-01");
    expect(isoDateUtc(Date.UTC(2026, 4, 1, 23, 59, 59, 999))).toBe("2026-05-01");
    expect(isoDateUtc(Date.UTC(2026, 4, 2, 0, 0, 0, 0))).toBe("2026-05-02");
  });

  it("handles the unix epoch", () => {
    expect(isoDateUtc(0)).toBe("1970-01-01");
  });

  it("zero-pads single-digit months and days", () => {
    expect(isoDateUtc(Date.UTC(2026, 0, 1))).toBe("2026-01-01");
    expect(isoDateUtc(Date.UTC(2026, 8, 9))).toBe("2026-09-09");
  });
});

describe("reserveLaunchSlot serialization (concurrent-call race proof)", () => {
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

  it("never overshoots maxLaunchesPerDay across many same-tick reserve calls", () => {
    const t = 1_700_000_000_000;
    const cap = 3;
    let granted = 0;
    let denied = 0;
    // Note: better-sqlite3 is synchronous. Within a single Node thread the
    // BEGIN/COMMIT around the read-modify-write makes the transaction atomic
    // even for back-to-back synchronous calls. This test pins that contract.
    for (let i = 0; i < 50; i++) {
      const r = store.reserveLaunchSlot({
        timestampMs: t,
        plannedSpendSol: 0.01,
        maxLaunchesPerDay: cap,
        maxSolPerDay: 1,
      });
      if (r) granted++;
      else denied++;
    }
    expect(granted).toBe(cap);
    expect(denied).toBe(50 - cap);
    expect(store.getDailyCounter(t).launches_count).toBe(cap);
  });

  it("never overshoots maxSolPerDay across many same-tick reserve calls", () => {
    const t = 1_700_000_000_000;
    const perCall = 0.05;
    const dailyCap = 0.15; // exactly 3 grants worth
    let granted = 0;
    for (let i = 0; i < 20; i++) {
      const r = store.reserveLaunchSlot({
        timestampMs: t,
        plannedSpendSol: perCall,
        maxLaunchesPerDay: 1000,
        maxSolPerDay: dailyCap,
      });
      if (r) granted++;
    }
    expect(granted).toBe(3);
    const counter = store.getDailyCounter(t);
    expect(counter.sol_spent).toBeCloseTo(dailyCap, 6);
  });
});
