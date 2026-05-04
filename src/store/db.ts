import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database, { type Database as DB } from "better-sqlite3";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tweets_seen (
  tweet_id TEXT PRIMARY KEY,
  author_handle TEXT NOT NULL,
  seen_at INTEGER NOT NULL,
  classifier_score REAL,
  decision TEXT NOT NULL,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_tweets_seen_at ON tweets_seen(seen_at DESC);

CREATE TABLE IF NOT EXISTS launches (
  mint TEXT PRIMARY KEY,
  ticker TEXT NOT NULL,
  name TEXT NOT NULL,
  source_tweet_id TEXT NOT NULL,
  source_author TEXT NOT NULL,
  sol_spent REAL NOT NULL,
  tx_signature TEXT NOT NULL,
  metadata_uri TEXT NOT NULL,
  image_cid TEXT NOT NULL,
  launched_at INTEGER NOT NULL,
  ai_reasoning TEXT
);
CREATE INDEX IF NOT EXISTS idx_launches_author_time ON launches(source_author, launched_at DESC);
CREATE INDEX IF NOT EXISTS idx_launches_at ON launches(launched_at DESC);

CREATE TABLE IF NOT EXISTS daily_counters (
  date TEXT PRIMARY KEY,
  launches_count INTEGER NOT NULL DEFAULT 0,
  sol_spent REAL NOT NULL DEFAULT 0
);
`;

export type Decision =
  | "launched"
  | "skipped_low_score"
  | "skipped_safety"
  | "skipped_validation"
  | "skipped_error";

export type SeenTweet = {
  tweet_id: string;
  author_handle: string;
  seen_at: number;
  classifier_score: number | null;
  decision: Decision;
  reason: string | null;
};

export type LaunchRecord = {
  mint: string;
  ticker: string;
  name: string;
  source_tweet_id: string;
  source_author: string;
  sol_spent: number;
  tx_signature: string;
  metadata_uri: string;
  image_cid: string;
  launched_at: number;
  ai_reasoning: string | null;
};

export type DailyCounter = {
  date: string;
  launches_count: number;
  sol_spent: number;
};

export class Store {
  private db: DB;

  constructor(dbPath: string) {
    mkdirSync(dirname(resolve(dbPath)), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.applyMigrations();
  }

  private applyMigrations(): void {
    this.db.exec(SCHEMA_SQL);
  }

  hasSeen(tweetId: string): boolean {
    const row = this.db.prepare("SELECT 1 FROM tweets_seen WHERE tweet_id = ?").get(tweetId);
    return row !== undefined;
  }

  recordSeen(record: SeenTweet): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO tweets_seen
         (tweet_id, author_handle, seen_at, classifier_score, decision, reason)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.tweet_id,
        record.author_handle,
        record.seen_at,
        record.classifier_score,
        record.decision,
        record.reason,
      );
  }

  recordLaunch(record: LaunchRecord): void {
    const insertLaunch = this.db.prepare(
      `INSERT INTO launches
       (mint, ticker, name, source_tweet_id, source_author, sol_spent,
        tx_signature, metadata_uri, image_cid, launched_at, ai_reasoning)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const updateCounter = this.db.prepare(
      `INSERT INTO daily_counters (date, launches_count, sol_spent)
       VALUES (?, 1, ?)
       ON CONFLICT(date) DO UPDATE SET
         launches_count = launches_count + 1,
         sol_spent = sol_spent + excluded.sol_spent`,
    );
    const date = isoDateUtc(record.launched_at);
    this.db.transaction(() => {
      insertLaunch.run(
        record.mint,
        record.ticker,
        record.name,
        record.source_tweet_id,
        record.source_author,
        record.sol_spent,
        record.tx_signature,
        record.metadata_uri,
        record.image_cid,
        record.launched_at,
        record.ai_reasoning,
      );
      updateCounter.run(date, record.sol_spent);
    })();
  }

  getDailyCounter(timestampMs: number): DailyCounter {
    const date = isoDateUtc(timestampMs);
    const row = this.db
      .prepare("SELECT date, launches_count, sol_spent FROM daily_counters WHERE date = ?")
      .get(date) as DailyCounter | undefined;
    return row ?? { date, launches_count: 0, sol_spent: 0 };
  }

  lastLaunchByAuthor(authorHandle: string): LaunchRecord | null {
    const row = this.db
      .prepare("SELECT * FROM launches WHERE source_author = ? ORDER BY launched_at DESC LIMIT 1")
      .get(authorHandle) as LaunchRecord | undefined;
    return row ?? null;
  }

  recentSeen(limit: number): SeenTweet[] {
    return this.db
      .prepare("SELECT * FROM tweets_seen ORDER BY seen_at DESC LIMIT ?")
      .all(limit) as SeenTweet[];
  }

  recentLaunches(limit: number): LaunchRecord[] {
    return this.db
      .prepare("SELECT * FROM launches ORDER BY launched_at DESC LIMIT ?")
      .all(limit) as LaunchRecord[];
  }

  getLaunch(mint: string): LaunchRecord | null {
    const row = this.db.prepare("SELECT * FROM launches WHERE mint = ?").get(mint) as
      | LaunchRecord
      | undefined;
    return row ?? null;
  }

  close(): void {
    this.db.close();
  }
}

export function isoDateUtc(timestampMs: number): string {
  // YYYY-MM-DD in UTC. Used as the daily_counters PK.
  const d = new Date(timestampMs);
  return d.toISOString().slice(0, 10);
}
