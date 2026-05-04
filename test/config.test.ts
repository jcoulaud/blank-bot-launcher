import { describe, expect, it } from "vitest";
import { ConfigError, parseEnv } from "../src/config.js";

const baseEnv = {
  SOLANA_PRIVATE_KEY: "fake-key",
  BLANK_API_KEY: "fake",
  X_API_KEY: "fake",
  X_API_SECRET: "fake",
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

  it("D5: rejects inconsistent cap math (per_launch × count > daily_sol)", () => {
    const broken = {
      ...baseEnv,
      MAX_SOL_PER_LAUNCH: "0.10",
      MAX_LAUNCHES_PER_DAY: "3",
      MAX_SOL_PER_DAY: "0.15", // 0.10*3 = 0.30 > 0.15
    };
    expect(() => parseEnv(broken as NodeJS.ProcessEnv)).toThrow(/Cap math/);
  });

  it("D5: accepts consistent cap math at exact boundary", () => {
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

  it("rejects half-configured Telegram (token but no chat id)", () => {
    const broken = { ...baseEnv, TELEGRAM_BOT_TOKEN: "abc" };
    expect(() => parseEnv(broken as NodeJS.ProcessEnv)).toThrow(/TELEGRAM_CHAT_ID/);
  });

  it("accepts both Telegram fields together", () => {
    const env = parseEnv({
      ...baseEnv,
      TELEGRAM_BOT_TOKEN: "abc",
      TELEGRAM_CHAT_ID: "123",
    } as NodeJS.ProcessEnv);
    expect(env.TELEGRAM_BOT_TOKEN).toBe("abc");
    expect(env.TELEGRAM_CHAT_ID).toBe("123");
  });
});
