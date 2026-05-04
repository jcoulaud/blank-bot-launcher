import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Accounts } from "../config.js";
import type { PipelineResult } from "../pipeline.js";
import type { Tweet } from "../sources/tweet-source.js";

export type BacktestReportEntry = {
  tweet: {
    id: string;
    url: string;
    authorHandle: string;
    authorId: string;
    text: string;
    createdAt: string;
    imageCount: number;
    isQuoteTweet: boolean;
  };
  result: PipelineResult;
};

export type BacktestReport = {
  generatedAt: string;
  accounts: string[];
  perAccountLimit: number;
  tweetsProcessed: number;
  summary: Record<string, number>;
  entries: BacktestReportEntry[];
};

export function buildBacktestReport(args: {
  accounts: Accounts;
  perAccountLimit: number;
  entries: BacktestReportEntry[];
  now?: Date;
}): BacktestReport {
  return {
    generatedAt: (args.now ?? new Date()).toISOString(),
    accounts: args.accounts.accounts.map((a) => a.handle),
    perAccountLimit: args.perAccountLimit,
    tweetsProcessed: args.entries.length,
    summary: summarizeBacktest(args.entries),
    entries: args.entries,
  };
}

export function buildBacktestEntry(tweet: Tweet, result: PipelineResult): BacktestReportEntry {
  return {
    tweet: {
      id: tweet.id,
      url: `https://x.com/${tweet.authorHandle}/status/${tweet.id}`,
      authorHandle: tweet.authorHandle,
      authorId: tweet.authorId,
      text: tweet.text,
      createdAt: tweet.createdAt.toISOString(),
      imageCount: tweet.images.length,
      isQuoteTweet: tweet.isQuoteTweet,
    },
    result,
  };
}

export function defaultBacktestReportPath(now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return `./data/backtests/backtest-${stamp}.json`;
}

export function defaultBacktestDbPath(now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return `./data/backtests/backtest-${stamp}.db`;
}

export function writeBacktestReport(path: string, report: BacktestReport): string {
  const absPath = resolve(path);
  const dir = dirname(absPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Tighten dir mode in case it pre-existed with a looser umask. Mirrors
  // the Store's pattern so backtests never leak reports to other local users.
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* best-effort */
  }
  writeFileSync(absPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  return absPath;
}

function summarizeBacktest(entries: BacktestReportEntry[]): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const entry of entries) {
    summary[entry.result.decision] = (summary[entry.result.decision] ?? 0) + 1;
  }
  return summary;
}
