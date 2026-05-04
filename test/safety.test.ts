import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Connection, Keypair } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/config.js";
import { checkSafety } from "../src/launcher/safety.js";
import type { Tweet } from "../src/sources/tweet-source.js";
import { Store } from "../src/store/db.js";

const env: Env = {
  SOLANA_PRIVATE_KEY: "x",
  BLANK_API_KEY: "x",
  X_API_KEY: "x",
  X_API_SECRET: "x",
  X_BEARER_TOKEN: "x",
  GOOGLE_GENERATIVE_AI_API_KEY: "x",
  PINATA_JWT: "x",
  LLM_MODEL: "gemini-2.5-flash",
  IMAGE_MODEL: "gemini-2.5-flash-image",
  CLASSIFIER_THRESHOLD: 0.85,
  PER_AUTHOR_COOLDOWN_HOURS: 6,
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
};

function fakeTweet(authorHandle = "elonmusk"): Tweet {
  return {
    id: "t1",
    authorHandle,
    authorId: "1",
    text: "hi",
    createdAt: new Date(),
    images: [],
    isReply: false,
    isRetweet: false,
    isQuoteTweet: false,
  };
}

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
    const decision = await checkSafety(fakeTweet(), {
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
      store.recordLaunch({
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
        ai_reasoning: null,
      });
    }
    const decision = await checkSafety(fakeTweet(), {
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
    store.recordLaunch({
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
      ai_reasoning: null,
    });
    const decision = await checkSafety(fakeTweet(), {
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
    const decision = await checkSafety(fakeTweet(), {
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

  it("rejects when same author launched recently (cooldown)", async () => {
    const now = Date.now();
    store.recordLaunch({
      mint: "M",
      ticker: "T",
      name: "n",
      source_tweet_id: "x",
      source_author: "elonmusk",
      sol_spent: 0,
      tx_signature: "s",
      metadata_uri: "u",
      image_cid: "c",
      launched_at: now - 60 * 60 * 1000, // 1 hour ago, cooldown is 6h
      ai_reasoning: null,
    });
    const decision = await checkSafety(fakeTweet("elonmusk"), {
      env,
      store,
      connection: fakeConnection(1.0),
      wallet,
      plannedSpendSol: 0.05,
      now,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("author_cooldown");
  });

  it("accepts after cooldown period elapses", async () => {
    const now = Date.now();
    store.recordLaunch({
      mint: "M",
      ticker: "T",
      name: "n",
      source_tweet_id: "x",
      source_author: "elonmusk",
      sol_spent: 0,
      tx_signature: "s",
      metadata_uri: "u",
      image_cid: "c",
      launched_at: now - 7 * 60 * 60 * 1000, // 7h ago > 6h cooldown
      ai_reasoning: null,
    });
    const decision = await checkSafety(fakeTweet("elonmusk"), {
      env,
      store,
      connection: fakeConnection(1.0),
      wallet,
      plannedSpendSol: 0.05,
      now,
    });
    expect(decision.ok).toBe(true);
  });

  it("rejects when wallet balance is insufficient", async () => {
    const decision = await checkSafety(fakeTweet(), {
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
