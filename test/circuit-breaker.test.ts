import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/config.js";
import { evaluateCircuitBreakers } from "../src/safety/circuit-breaker.js";
import { Store } from "../src/store/db.js";

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
  PENDING_LOCK_STALE_S: 300,
  DB_PATH: "x",
  LOG_LEVEL: "info",
  SKIP_OLDER_THAN_S: 300,
  STAKING_SHARE_BPS: 8000,
  CIRCUIT_BREAKER_WINDOW_S: 900,
  CIRCUIT_BREAKER_PAUSE_S: 60,
  MAX_CONSECUTIVE_PROVIDER_ERRORS: 3,
  MAX_CONSECUTIVE_IPFS_ERRORS: 3,
  MAX_CONSECUTIVE_LAUNCH_ERRORS: 2,
  MAX_X_API_USD_PER_DAY: 0.01,
};

describe("evaluateCircuitBreakers", () => {
  let tmp: string;
  let store: Store;
  const now = Date.UTC(2026, 4, 6, 12, 0, 0);

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "blank-bot-breaker-test-"));
    store = new Store(join(tmp, "test.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("trips after consecutive provider errors in the window", () => {
    for (let i = 0; i < 3; i++) {
      store.recordPipelineEvent({
        stage: "metadata",
        status: "error",
        startedAt: now + i,
        finishedAt: now + i,
        detail: "quota",
      });
    }
    const decision = evaluateCircuitBreakers({ env, store, now: now + 10 });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("provider_errors");
  });

  it("does not count provider errors across a successful provider event", () => {
    store.recordPipelineEvent({
      stage: "metadata",
      status: "error",
      startedAt: now,
      finishedAt: now,
    });
    store.recordPipelineEvent({
      stage: "metadata",
      status: "ok",
      startedAt: now + 1,
      finishedAt: now + 1,
    });
    store.recordPipelineEvent({
      stage: "image",
      status: "error",
      startedAt: now + 2,
      finishedAt: now + 2,
    });
    const decision = evaluateCircuitBreakers({ env, store, now: now + 10 });
    expect(decision.ok).toBe(true);
  });

  it("counts failed attempts even when earlier stages in each attempt succeeded", () => {
    for (let i = 0; i < 3; i++) {
      store.recordPipelineEvent({
        stage: "classify",
        status: "ok",
        startedAt: now + i * 10,
        finishedAt: now + i * 10,
      });
      store.recordPipelineEvent({
        stage: "metadata",
        status: "error",
        startedAt: now + i * 10 + 1,
        finishedAt: now + i * 10 + 1,
        detail: "quota",
      });
    }
    const decision = evaluateCircuitBreakers({ env, store, now: now + 40 });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("provider_errors");
  });

  it("trips when estimated X API spend reaches the daily cap", () => {
    store.recordXApiUsage({
      timestampMs: now,
      source: "test",
      resources: [
        { resource_type: "post_read", resource_id: "t1", cost_usd: 0.005 },
        { resource_type: "user_read", resource_id: "u1", cost_usd: 0.01 },
      ],
    });
    const decision = evaluateCircuitBreakers({ env, store, now });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("x_api_spend");
  });
});
