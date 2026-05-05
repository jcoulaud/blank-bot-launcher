import { parseArgs } from "node:util";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

export type CliFlags = {
  checkConfig: boolean;
  dryRun: boolean;
  backtest: boolean;
  backtestLimit: number;
  backtestDbPath?: string;
  backtestReportPath?: string;
  dashboardOnly: boolean;
  replayTweetId?: string;
  yes: boolean;
  force: boolean;
  help: boolean;
};

export class CliFlagsError extends Error {
  override readonly name = "CliFlagsError";
}

export function parseCliFlags(argv: string[]): CliFlags {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        "check-config": { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
        backtest: { type: "boolean", default: false },
        "backtest-limit": { type: "string" },
        "backtest-db": { type: "string" },
        "backtest-report": { type: "string" },
        "dashboard-only": { type: "boolean", default: false },
        yes: { type: "boolean", short: "y", default: false },
        force: { type: "boolean", default: false },
        replay: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (err) {
    // node:util throws on unknown flags / typos under strict:true. Convert to
    // a CliFlagsError so the caller's exit-with-message path applies.
    throw new CliFlagsError(err instanceof Error ? err.message : String(err));
  }
  const { values } = parsed;
  const flags: CliFlags = {
    checkConfig: Boolean(values["check-config"]),
    dryRun: Boolean(values["dry-run"]),
    backtest: Boolean(values.backtest),
    backtestLimit: parsePositiveIntFlag(values["backtest-limit"], "--backtest-limit") ?? 50,
    dashboardOnly: Boolean(values["dashboard-only"]),
    yes: Boolean(values.yes),
    force: Boolean(values.force),
    help: Boolean(values.help),
  };
  if (typeof values["backtest-db"] === "string") flags.backtestDbPath = values["backtest-db"];
  if (typeof values["backtest-report"] === "string") {
    flags.backtestReportPath = values["backtest-report"];
  }
  if (typeof values.replay === "string") flags.replayTweetId = values.replay;

  // Skip flag-combination validation when --help is set so `--help --whatever`
  // still prints help instead of erroring.
  if (flags.help) return flags;

  if (flags.backtest && flags.replayTweetId) {
    throw new CliFlagsError("--backtest cannot be combined with --replay.");
  }
  if (flags.dashboardOnly && (flags.backtest || flags.replayTweetId || flags.checkConfig)) {
    throw new CliFlagsError(
      "--dashboard-only cannot be combined with --backtest, --replay, or --check-config.",
    );
  }
  if (!flags.backtest) {
    if (flags.backtestDbPath) throw new CliFlagsError("--backtest-db requires --backtest.");
    if (flags.backtestReportPath) throw new CliFlagsError("--backtest-report requires --backtest.");
    if (values["backtest-limit"] !== undefined) {
      throw new CliFlagsError("--backtest-limit requires --backtest.");
    }
  }

  // --force on a live run would bypass dedup and the classifier threshold
  // and start launching at the per-day cap, so restrict it to --replay,
  // --dry-run, and --backtest where there's no live spend.
  if (
    flags.force &&
    !flags.replayTweetId &&
    !flags.dryRun &&
    !flags.backtest &&
    !flags.dashboardOnly
  ) {
    throw new CliFlagsError(
      "--force requires --replay or --dry-run. Refusing to start a live run with --force.",
    );
  }
  return flags;
}

function parsePositiveIntFlag(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new CliFlagsError(`${label} must be a positive integer.`);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new CliFlagsError(`${label} must be a positive integer.`);
  }
  return parsed;
}

export function printHelp(): void {
  console.log(`blank-bot - autonomous Solana memecoin launcher

Usage:
  npm run start                 normal autonomous run
  npm run start -- --dry-run    full pipeline, skip the SDK launch call
  npm run backtest              fetch recent configured-account tweets and run dry
  npm run backtest -- --backtest-limit 50
                                process up to N eligible tweets per account
                                (X may return one extra page before reaching N)
  npm run start -- --replay <id>
                                fetch one tweet by id and run it through the pipeline
  npm run start -- --dashboard-only
                                serve the local dashboard without connecting to X
  npm run start -- --force      bypass the dedup check and the classifier threshold
                                  (only valid with --replay, --dry-run, or --backtest)
  npm run check-config          validate env, accounts, wallet balance, then exit
  npm run start -- --yes        skip the 5-second confirmation banner
  npm run start -- --help       this message

Environment: see .env.example
`);
}

export function loadKeypair(privateKeyEnv: string): Keypair {
  const trimmed = privateKeyEnv.trim();
  // Solana CLI keypair format: JSON array of exactly 64 bytes.
  if (trimmed.startsWith("[")) {
    const arr = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(arr) || arr.length !== 64) {
      throw new Error(
        "SOLANA_PRIVATE_KEY JSON array must be exactly 64 bytes (Solana ed25519 secret key).",
      );
    }
    if (!arr.every((n) => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 255)) {
      throw new Error("SOLANA_PRIVATE_KEY JSON array must contain integers 0-255.");
    }
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }
  // Otherwise: base58
  return Keypair.fromSecretKey(bs58.decode(trimmed));
}
