import { describe, expect, it } from "vitest";
import type { CliFlags } from "../src/cli.js";
import type { Config, Env } from "../src/config.js";
import { buildBalanceWarning, buildBannerLines } from "../src/util/banner.js";

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
  RPC_URL: "https://api.mainnet-beta.solana.com",
  ACCOUNTS_FILE: "x",
  SHUTDOWN_TIMEOUT_S: 90,
  DB_PATH: "x",
  LOG_LEVEL: "info",
  SKIP_OLDER_THAN_S: 300,
  STAKING_SHARE_BPS: 8000,
  PENDING_LOCK_STALE_S: 300,
  CIRCUIT_BREAKER_WINDOW_S: 900,
  CIRCUIT_BREAKER_PAUSE_S: 60,
  MAX_CONSECUTIVE_PROVIDER_ERRORS: 3,
  MAX_CONSECUTIVE_IPFS_ERRORS: 3,
  MAX_CONSECUTIVE_LAUNCH_ERRORS: 2,
  MAX_X_API_USD_PER_DAY: 25,
};

const accounts: Config["accounts"] = {
  accounts: [{ handle: "elonmusk" }, { handle: "sama" }],
};

const flags: CliFlags = {
  checkConfig: false,
  dryRun: false,
  backtest: false,
  backtestLimit: 50,
  dashboardOnly: false,
  yes: true,
  force: false,
  help: false,
};

describe("buildBalanceWarning", () => {
  it("returns null when balance is at or below the warn threshold", () => {
    expect(buildBalanceWarning({ balanceSol: 1.5, env })).toBeNull();
    expect(buildBalanceWarning({ balanceSol: env.WARN_IF_BALANCE_ABOVE_SOL, env })).toBeNull();
  });

  it("warns when balance exceeds the warn threshold", () => {
    const w = buildBalanceWarning({ balanceSol: 5, env });
    expect(w).not.toBeNull();
    expect(w).toContain("WARNING");
    expect(w).toContain("5.00 SOL");
    expect(w).toContain(`WARN_IF_BALANCE_ABOVE_SOL=${env.WARN_IF_BALANCE_ABOVE_SOL}`);
  });

  it("formats balance to two decimals", () => {
    const w = buildBalanceWarning({ balanceSol: 2.123456, env });
    expect(w).toContain("2.12 SOL");
  });
});

describe("buildBannerLines", () => {
  it("identifies network as mainnet-beta when RPC URL contains 'mainnet'", () => {
    const lines = buildBannerLines({
      env,
      accounts,
      walletPubkey: "AAAAAAaaaa1234567890ZZZZZ",
      balanceSol: 1,
      flags,
    });
    expect(lines.join("\n")).toContain("mainnet-beta");
  });

  it("identifies network as devnet for devnet RPC URLs", () => {
    const lines = buildBannerLines({
      env: { ...env, RPC_URL: "https://api.devnet.solana.com" },
      accounts,
      walletPubkey: "x".repeat(20),
      balanceSol: 1,
      flags,
    });
    expect(lines.join("\n")).toContain(" Network:    devnet");
  });

  it("uses 'custom' for unrecognised RPC URLs", () => {
    const lines = buildBannerLines({
      env: { ...env, RPC_URL: "https://my-private.rpc" },
      accounts,
      walletPubkey: "x".repeat(20),
      balanceSol: 1,
      flags,
    });
    expect(lines.join("\n")).toContain(" Network:    custom");
  });

  it.each([
    [{ ...flags, backtest: true, backtestLimit: 25 }, "BACKTEST 25/account"],
    [{ ...flags, dryRun: true }, "DRY-RUN"],
    [{ ...flags, dashboardOnly: true }, "DASHBOARD-ONLY"],
    [{ ...flags, checkConfig: true }, "CHECK-CONFIG"],
    [{ ...flags, replayTweetId: "1234" }, "REPLAY 1234"],
    [flags, "LIVE"],
  ])("renders mode for the active flags", (f, expected) => {
    const lines = buildBannerLines({
      env,
      accounts,
      walletPubkey: "x".repeat(20),
      balanceSol: 1,
      flags: f,
    });
    expect(lines.join("\n")).toContain(expected);
  });

  it("appends '+FORCE' to mode line when force is set", () => {
    const lines = buildBannerLines({
      env,
      accounts,
      walletPubkey: "x".repeat(20),
      balanceSol: 1,
      flags: { ...flags, force: true },
    });
    const modeLine = lines.find((l) => l.includes("Mode:"));
    expect(modeLine).toContain("+FORCE");
  });

  it("masks wallet pubkey to first 6 + last 4", () => {
    const lines = buildBannerLines({
      env,
      accounts,
      walletPubkey: "ABCDEF1234567890XYZ9999",
      balanceSol: 0.123,
      flags,
    });
    expect(lines.join("\n")).toContain("ABCDEF...9999");
  });

  it("indicates dashboard disabled when DASHBOARD_PORT is unset", () => {
    const lines = buildBannerLines({
      env,
      accounts,
      walletPubkey: "x".repeat(20),
      balanceSol: 1,
      flags,
    });
    expect(lines.join("\n")).toContain("Dashboard:  disabled");
  });
});
