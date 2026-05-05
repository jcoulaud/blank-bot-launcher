import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { CliFlagsError, loadKeypair, parseCliFlags } from "../src/cli.js";

describe("loadKeypair", () => {
  it("loads from a Solana CLI JSON-array keypair", () => {
    const kp = Keypair.generate();
    const arr = JSON.stringify(Array.from(kp.secretKey));
    const loaded = loadKeypair(arr);
    expect(loaded.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  it("loads from a base58-encoded secret key", () => {
    const kp = Keypair.generate();
    const b58 = bs58.encode(kp.secretKey);
    const loaded = loadKeypair(b58);
    expect(loaded.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  it("trims whitespace before parsing", () => {
    const kp = Keypair.generate();
    const b58 = bs58.encode(kp.secretKey);
    const loaded = loadKeypair(`  ${b58}\n`);
    expect(loaded.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  it("rejects malformed input", () => {
    expect(() => loadKeypair("not-a-real-key")).toThrow();
  });
});

describe("parseCliFlags", () => {
  it("defaults all booleans to false", () => {
    const flags = parseCliFlags([]);
    expect(flags.checkConfig).toBe(false);
    expect(flags.dryRun).toBe(false);
    expect(flags.backtest).toBe(false);
    expect(flags.backtestLimit).toBe(50);
    expect(flags.dashboardOnly).toBe(false);
    expect(flags.yes).toBe(false);
    expect(flags.force).toBe(false);
    expect(flags.replayTweetId).toBeUndefined();
  });

  it("parses --replay <id>", () => {
    const flags = parseCliFlags(["--replay", "12345"]);
    expect(flags.replayTweetId).toBe("12345");
  });

  it("parses --dry-run", () => {
    expect(parseCliFlags(["--dry-run"]).dryRun).toBe(true);
  });

  it("parses --backtest with default and explicit limit", () => {
    expect(parseCliFlags(["--backtest"]).backtest).toBe(true);
    expect(parseCliFlags(["--backtest"]).backtestLimit).toBe(50);
    expect(parseCliFlags(["--backtest", "--backtest-limit", "25"]).backtestLimit).toBe(25);
  });

  it("parses --backtest-db and --backtest-report", () => {
    const flags = parseCliFlags([
      "--backtest",
      "--backtest-db",
      "./data/custom.db",
      "--backtest-report",
      "./data/report.json",
    ]);
    expect(flags.backtestDbPath).toBe("./data/custom.db");
    expect(flags.backtestReportPath).toBe("./data/report.json");
  });

  it("parses --check-config", () => {
    expect(parseCliFlags(["--check-config"]).checkConfig).toBe(true);
  });

  it("parses --dashboard-only", () => {
    expect(parseCliFlags(["--dashboard-only"]).dashboardOnly).toBe(true);
  });

  it("parses --yes / -y", () => {
    expect(parseCliFlags(["--yes"]).yes).toBe(true);
    expect(parseCliFlags(["-y"]).yes).toBe(true);
  });

  it("rejects --force without --replay or --dry-run", () => {
    expect(() => parseCliFlags(["--force"])).toThrow(CliFlagsError);
    expect(() => parseCliFlags(["--force"])).toThrow(/--force requires/);
  });

  it("accepts --force with --replay", () => {
    const flags = parseCliFlags(["--force", "--replay", "123"]);
    expect(flags.force).toBe(true);
    expect(flags.replayTweetId).toBe("123");
  });

  it("accepts --force with --dry-run", () => {
    const flags = parseCliFlags(["--force", "--dry-run"]);
    expect(flags.force).toBe(true);
    expect(flags.dryRun).toBe(true);
  });

  it("accepts --force with --backtest", () => {
    const flags = parseCliFlags(["--force", "--backtest"]);
    expect(flags.force).toBe(true);
    expect(flags.backtest).toBe(true);
  });

  it("rejects backtest-only options outside --backtest", () => {
    expect(() => parseCliFlags(["--backtest-limit", "50"])).toThrow(CliFlagsError);
    expect(() => parseCliFlags(["--backtest-db", "./x.db"])).toThrow(CliFlagsError);
    expect(() => parseCliFlags(["--backtest-report", "./x.json"])).toThrow(CliFlagsError);
  });

  it("rejects invalid backtest limits", () => {
    expect(() => parseCliFlags(["--backtest", "--backtest-limit", "0"])).toThrow(CliFlagsError);
    expect(() => parseCliFlags(["--backtest", "--backtest-limit", "1.5"])).toThrow(CliFlagsError);
  });

  it("rejects --backtest with --replay", () => {
    expect(() => parseCliFlags(["--backtest", "--replay", "123"])).toThrow(CliFlagsError);
  });

  it("rejects --dashboard-only with source modes", () => {
    expect(() => parseCliFlags(["--dashboard-only", "--backtest"])).toThrow(CliFlagsError);
    expect(() => parseCliFlags(["--dashboard-only", "--replay", "123"])).toThrow(CliFlagsError);
    expect(() => parseCliFlags(["--dashboard-only", "--check-config"])).toThrow(CliFlagsError);
  });
});
