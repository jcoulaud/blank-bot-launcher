import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Connection, Keypair } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/config.js";
import { checkSafety, evaluateCaps } from "../src/safety/safety.js";
import { Store } from "../src/store/db.js";
import { seedLaunch } from "./helpers/db-helpers.js";

const env: Env = {
  SOLANA_PRIVATE_KEY: "x",
  BLANK_API_KEY: "x",
  BLANK_API_BASE_URL: "https://api.blank.build",
  X_BEARER_TOKEN: "x",
  GOOGLE_GENERATIVE_AI_API_KEY: "x",
  PINATA_JWT: "x",
  LLM_MODEL: "gemini-2.5-flash",
  IMAGE_MODEL: "gemini-2.5-flash-image",
  CLASSIFIER_THRESHOLD: 0.85,
  MAX_SOL_PER_LAUNCH: 0.05,
  MAX_LAUNCHES_PER_DAY: 3,
  MAX_SOL_PER_DAY: 0.15,
  WARN_IF_BALANCE_ABOVE_SOL: 2,
  RPC_URL: "https://x",
  ACCOUNTS_FILE: "x",
  SHUTDOWN_TIMEOUT_S: 90,
  DB_PATH: "x",
  LOG_LEVEL: "info",
  SKIP_OLDER_THAN_S: 300,
  STAKING_SHARE_BPS: 8000,
};

function fakeConnection(balanceSol: number): Connection {
  return {
    getBalance: vi.fn().mockResolvedValue(balanceSol * 1_000_000_000),
  } as unknown as Connection;
}

describe("checkSafety", () => {
  let tmp: string;
  let store: Store;
  const wallet = Keypair.generate();

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "blank-bot-test-"));
    store = new Store(join(tmp, "test.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("accepts a clean tweet with sufficient balance", async () => {
    const decision = await checkSafety({
      env,
      store,
      connection: fakeConnection(1.0),
      wallet,
      plannedSpendSol: 0.05,
      now: Date.now(),
    });
    expect(decision.ok).toBe(true);
  });

  it("rejects when daily count cap is hit", async () => {
    const t = Date.now();
    for (let i = 0; i < 3; i++) {
      seedLaunch(store, {
        mint: `M${i}`,
        ticker: `T${i}`,
        name: "n",
        source_tweet_id: `tw${i}`,
        source_author: "other",
        sol_spent: 0,
        tx_signature: "s",
        metadata_uri: "u",
        image_cid: "c",
        launched_at: t,
        classification_reason: null,
      });
    }
    const decision = await checkSafety({
      env,
      store,
      connection: fakeConnection(1.0),
      wallet,
      plannedSpendSol: 0.05,
      now: t,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("daily_count_cap");
  });

  it("rejects when daily SOL cap would be exceeded", async () => {
    const t = Date.now();
    seedLaunch(store, {
      mint: "M",
      ticker: "T",
      name: "n",
      source_tweet_id: "x",
      source_author: "other",
      sol_spent: 0.12,
      tx_signature: "s",
      metadata_uri: "u",
      image_cid: "c",
      launched_at: t,
      classification_reason: null,
    });
    const decision = await checkSafety({
      env,
      store,
      connection: fakeConnection(1.0),
      wallet,
      plannedSpendSol: 0.05, // 0.12 + 0.05 = 0.17 > 0.15 cap
      now: t,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("daily_sol_cap");
  });

  it("rejects when planned spend exceeds per-launch cap", async () => {
    const decision = await checkSafety({
      env,
      store,
      connection: fakeConnection(1.0),
      wallet,
      plannedSpendSol: 0.1, // > MAX_SOL_PER_LAUNCH (0.05)
      now: Date.now(),
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("per_launch_cap");
  });

  it("rejects when wallet balance is insufficient", async () => {
    const decision = await checkSafety({
      env,
      store,
      connection: fakeConnection(0.001),
      wallet,
      plannedSpendSol: 0.05,
      now: Date.now(),
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("insufficient_balance");
  });
});

describe("evaluateCaps (pure, no RPC)", () => {
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

  it("returns ok=true (caps cleared) on a fresh DB; balance not yet checked", () => {
    const decision = evaluateCaps({
      env,
      store,
      plannedSpendSol: 0.05,
      now: Date.now(),
    });
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.balanceSol).toBe(0); // sentinel; balance is checked separately
  });

  it("rejects with daily_count_cap when MAX_LAUNCHES_PER_DAY is hit", () => {
    const t = Date.now();
    for (let i = 0; i < env.MAX_LAUNCHES_PER_DAY; i++) {
      seedLaunch(store, {
        mint: `M${i}`,
        ticker: `T${i}`,
        name: "n",
        source_tweet_id: `tw${i}`,
        source_author: "other",
        sol_spent: 0,
        tx_signature: "s",
        metadata_uri: "u",
        image_cid: "c",
        launched_at: t,
        classification_reason: null,
      });
    }
    const decision = evaluateCaps({ env, store, plannedSpendSol: 0.01, now: t });
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe("daily_count_cap");
      expect(decision.detail).toContain(`${env.MAX_LAUNCHES_PER_DAY}/${env.MAX_LAUNCHES_PER_DAY}`);
    }
  });

  it("rejects with daily_sol_cap when planned spend would push past MAX_SOL_PER_DAY", () => {
    const t = Date.now();
    seedLaunch(store, {
      mint: "M",
      ticker: "T",
      name: "n",
      source_tweet_id: "x",
      source_author: "other",
      sol_spent: 0.12,
      tx_signature: "s",
      metadata_uri: "u",
      image_cid: "c",
      launched_at: t,
      classification_reason: null,
    });
    const decision = evaluateCaps({ env, store, plannedSpendSol: 0.05, now: t });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("daily_sol_cap");
  });

  it("rejects with per_launch_cap when planned spend exceeds MAX_SOL_PER_LAUNCH", () => {
    const decision = evaluateCaps({
      env,
      store,
      plannedSpendSol: env.MAX_SOL_PER_LAUNCH + 0.01,
      now: Date.now(),
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("per_launch_cap");
  });

  it("checks cap order: count > sol > per-launch", () => {
    const now = Date.now();
    // Hit count cap and also exceed the per-launch cap.
    for (let i = 0; i < env.MAX_LAUNCHES_PER_DAY; i++) {
      seedLaunch(store, {
        mint: `M${i}`,
        ticker: `T${i}`,
        name: "n",
        source_tweet_id: `t${i}`,
        source_author: "elonmusk",
        sol_spent: 0,
        tx_signature: "s",
        metadata_uri: "u",
        image_cid: "c",
        launched_at: now,
        classification_reason: null,
      });
    }
    const decision = evaluateCaps({
      env,
      store,
      plannedSpendSol: env.MAX_SOL_PER_LAUNCH + 1, // also exceeds per-launch cap
      now,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("daily_count_cap"); // count is checked first
  });
});
