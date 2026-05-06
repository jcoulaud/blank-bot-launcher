import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { errMsg } from "./util/errors.js";

// 1-lamport epsilon. Used by config-time cap math validation and by the
// runtime safety + reservation paths so JS float math at the boundary
// (e.g. 0.05 * 3 = 0.15000000000000002) doesn't trip equal-equal checks.
export const FLOAT_EPS_SOL = 1e-9;

const envSchema = z.object({
  // Required
  SOLANA_PRIVATE_KEY: z.string().min(1, "SOLANA_PRIVATE_KEY is required"),
  BLANK_API_KEY: z.string().min(1, "BLANK_API_KEY is required"),
  BLANK_API_BASE_URL: z.string().url().default("https://api.blank.build"),
  X_BEARER_TOKEN: z.string().min(1, "X_BEARER_TOKEN is required"),
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().min(1, "GOOGLE_GENERATIVE_AI_API_KEY is required"),
  PINATA_JWT: z.string().min(1, "PINATA_JWT is required"),

  // Optional with defaults
  LLM_MODEL: z.string().default("gemini-2.5-flash"),
  IMAGE_MODEL: z.string().default("gemini-2.5-flash-image"),
  CLASSIFIER_THRESHOLD: z.coerce.number().min(0).max(1).default(0.85),
  // Cap minimum is 1000 lamports (1e-6 SOL). Anything smaller is almost
  // certainly a typo (extra zero in the env file) and would make the
  // FLOAT_EPS_SOL epsilon dominate the cap, defeating the safety check.
  MAX_SOL_PER_LAUNCH: z.coerce.number().min(1e-6).default(0.05),
  MAX_LAUNCHES_PER_DAY: z.coerce.number().int().positive().default(3),
  MAX_SOL_PER_DAY: z.coerce.number().min(1e-6).default(0.15),
  WARN_IF_BALANCE_ABOVE_SOL: z.coerce.number().positive().default(2),
  RPC_URL: z.string().url().default("https://api.mainnet-beta.solana.com"),
  ACCOUNTS_FILE: z.string().default("./accounts.yaml"),
  SHUTDOWN_TIMEOUT_S: z.coerce.number().int().positive().default(90),
  DB_PATH: z.string().default("./data/bot.db"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  SKIP_OLDER_THAN_S: z.coerce.number().int().positive().default(300),
  STAKING_SHARE_BPS: z.coerce.number().int().min(0).max(10000).default(8000),

  // Optional, off by default
  DASHBOARD_PORT: z.coerce.number().int().positive().optional(),
});

export type Env = z.infer<typeof envSchema>;

const accountsSchema = z.object({
  accounts: z
    .array(z.object({ handle: z.string().regex(/^[A-Za-z0-9_]{1,15}$/) }))
    .min(1, "accounts.yaml must list at least one account"),
});

export type Accounts = z.infer<typeof accountsSchema>;

export type Config = {
  env: Env;
  accounts: Accounts;
};

export function loadConfig(): Config {
  const env = parseEnv(process.env);
  const accounts = loadAccountsFile(env.ACCOUNTS_FILE);
  return { env, accounts };
}

export function parseEnv(raw: NodeJS.ProcessEnv): Env {
  // Strip empty-string env vars so zod's .optional() / .default() actually fire.
  // Without this, lines like `DASHBOARD_PORT=` in .env give "" which coerces to 0
  // and trips the .positive() check.
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" && value.length > 0) cleaned[key] = value;
  }
  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    const issues = result.error.issues
      .map((e) => `  - ${e.path.join(".")}: ${e.message}`)
      .join("\n");
    throw new ConfigError(`Environment validation failed:\n${issues}`);
  }
  const env = result.data;

  const maxImpliedDailySpend = env.MAX_SOL_PER_LAUNCH * env.MAX_LAUNCHES_PER_DAY;
  if (maxImpliedDailySpend > env.MAX_SOL_PER_DAY + FLOAT_EPS_SOL) {
    throw new ConfigError(
      `Cap math is inconsistent: MAX_SOL_PER_LAUNCH (${env.MAX_SOL_PER_LAUNCH}) * MAX_LAUNCHES_PER_DAY (${env.MAX_LAUNCHES_PER_DAY}) = ${maxImpliedDailySpend} but MAX_SOL_PER_DAY = ${env.MAX_SOL_PER_DAY}.\nFix: set MAX_SOL_PER_DAY to at least ${maxImpliedDailySpend}, or reduce MAX_SOL_PER_LAUNCH/MAX_LAUNCHES_PER_DAY.`,
    );
  }

  if (env.WARN_IF_BALANCE_ABOVE_SOL <= env.MAX_SOL_PER_DAY) {
    throw new ConfigError(
      `WARN_IF_BALANCE_ABOVE_SOL (${env.WARN_IF_BALANCE_ABOVE_SOL}) must be greater than ` +
        `MAX_SOL_PER_DAY (${env.MAX_SOL_PER_DAY}); otherwise the warning fires every day.`,
    );
  }

  return env;
}

export function loadAccountsFile(path: string): Accounts {
  const absPath = resolve(path);
  let raw: string;
  try {
    raw = readFileSync(absPath, "utf-8");
  } catch (_err) {
    throw new ConfigError(
      `Could not read accounts file at ${absPath}. Copy accounts.example.yaml to accounts.yaml.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new ConfigError(`Failed to parse YAML at ${absPath}: ${errMsg(err)}`);
  }
  const result = accountsSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((e) => `  - ${e.path.join(".")}: ${e.message}`)
      .join("\n");
    throw new ConfigError(`accounts.yaml validation failed:\n${issues}`);
  }
  return result.data;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}
