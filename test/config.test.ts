import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, loadAccountsFile, parseEnv } from "../src/config.js";

const baseEnv = {
  SOLANA_PRIVATE_KEY: "fake-key",
  BLANK_API_KEY: "fake",
  X_BEARER_TOKEN: "fake",
  GOOGLE_GENERATIVE_AI_API_KEY: "fake",
  PINATA_JWT: "fake",
};

describe("parseEnv", () => {
  it("accepts a fully-defaulted minimum config", () => {
    const env = parseEnv(baseEnv as NodeJS.ProcessEnv);
    expect(env.MAX_SOL_PER_LAUNCH).toBe(0.05);
    expect(env.MAX_LAUNCHES_PER_DAY).toBe(3);
    expect(env.MAX_SOL_PER_DAY).toBe(0.15);
    expect(env.CLASSIFIER_THRESHOLD).toBe(0.85);
    expect(env.LLM_MODEL).toBe("gemini-2.5-flash");
  });

  it("throws ConfigError when a required field is missing", () => {
    const broken = { ...baseEnv, SOLANA_PRIVATE_KEY: "" };
    expect(() => parseEnv(broken as NodeJS.ProcessEnv)).toThrow(ConfigError);
    expect(() => parseEnv(broken as NodeJS.ProcessEnv)).toThrow(/SOLANA_PRIVATE_KEY/);
  });

  it("rejects out-of-range CLASSIFIER_THRESHOLD", () => {
    const broken = { ...baseEnv, CLASSIFIER_THRESHOLD: "1.5" };
    expect(() => parseEnv(broken as NodeJS.ProcessEnv)).toThrow(ConfigError);
  });

  it("rejects inconsistent cap math", () => {
    const broken = {
      ...baseEnv,
      MAX_SOL_PER_LAUNCH: "0.10",
      MAX_LAUNCHES_PER_DAY: "3",
      MAX_SOL_PER_DAY: "0.15", // 0.10*3 = 0.30 > 0.15
    };
    expect(() => parseEnv(broken as NodeJS.ProcessEnv)).toThrow(/Cap math/);
  });

  it("accepts consistent cap math at exact boundary", () => {
    const env = parseEnv({
      ...baseEnv,
      MAX_SOL_PER_LAUNCH: "0.05",
      MAX_LAUNCHES_PER_DAY: "3",
      MAX_SOL_PER_DAY: "0.15",
    } as NodeJS.ProcessEnv);
    expect(env.MAX_SOL_PER_DAY).toBe(0.15);
  });

  it("rejects WARN_IF_BALANCE_ABOVE_SOL not greater than MAX_SOL_PER_DAY", () => {
    const broken = {
      ...baseEnv,
      MAX_SOL_PER_DAY: "0.15",
      WARN_IF_BALANCE_ABOVE_SOL: "0.10",
    };
    expect(() => parseEnv(broken as NodeJS.ProcessEnv)).toThrow(/WARN_IF_BALANCE_ABOVE_SOL/);
  });
});

describe("loadAccountsFile", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "blank-bot-accounts-test-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("parses a valid YAML accounts file", () => {
    const path = join(tmp, "accounts.yaml");
    writeFileSync(path, "accounts:\n  - handle: elonmusk\n  - handle: sama\n");
    const accounts = loadAccountsFile(path);
    expect(accounts.accounts).toHaveLength(2);
    expect(accounts.accounts[0]?.handle).toBe("elonmusk");
  });

  it("throws ConfigError with helpful message when file is missing", () => {
    expect(() => loadAccountsFile(join(tmp, "missing.yaml"))).toThrow(ConfigError);
    expect(() => loadAccountsFile(join(tmp, "missing.yaml"))).toThrow(/Could not read/);
  });

  it("throws ConfigError on malformed YAML", () => {
    const path = join(tmp, "broken.yaml");
    writeFileSync(path, "accounts:\n  - handle: [unclosed\n");
    expect(() => loadAccountsFile(path)).toThrow(ConfigError);
  });

  it("throws ConfigError when handle violates the regex", () => {
    const path = join(tmp, "bad-handle.yaml");
    writeFileSync(path, "accounts:\n  - handle: 'with spaces'\n");
    expect(() => loadAccountsFile(path)).toThrow(ConfigError);
  });

  it("throws ConfigError when accounts array is empty", () => {
    const path = join(tmp, "empty.yaml");
    writeFileSync(path, "accounts: []\n");
    expect(() => loadAccountsFile(path)).toThrow(ConfigError);
    expect(() => loadAccountsFile(path)).toThrow(/at least one account/);
  });
});
