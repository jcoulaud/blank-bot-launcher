import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database, { type Database as DB } from "better-sqlite3";
import { z } from "zod";
import { FLOAT_EPS_SOL } from "../config.js";
import {
  uniqueUsageResources,
  X_API_USAGE_RESOURCE_TYPES,
  type XApiUsageResource,
  type XApiUsageResourceType,
} from "../util/x-api-cost.js";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tweets_seen (
  tweet_id TEXT PRIMARY KEY,
  author_handle TEXT NOT NULL,
  seen_at INTEGER NOT NULL,
  classifier_score REAL,
  decision TEXT NOT NULL,
  reason TEXT,
  seen_count INTEGER NOT NULL DEFAULT 1
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
  classification_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_launches_author_time ON launches(source_author, launched_at DESC);
CREATE INDEX IF NOT EXISTS idx_launches_at ON launches(launched_at DESC);

CREATE TABLE IF NOT EXISTS daily_counters (
  date TEXT PRIMARY KEY,
  launches_count INTEGER NOT NULL DEFAULT 0,
  sol_spent REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS x_api_usage_resources (
  date TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  source TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  seen_count INTEGER NOT NULL DEFAULT 1,
  cost_usd REAL NOT NULL,
  PRIMARY KEY (date, resource_type, resource_id)
);
CREATE INDEX IF NOT EXISTS idx_x_api_usage_date ON x_api_usage_resources(date);
`;

// Schemas validate every row read from SQLite. This catches schema drift,
// column reorders, and migration mistakes before they touch launch decisions.
const DecisionSchema = z.enum([
  "launched",
  "skipped_low_score",
  "skipped_safety",
  "skipped_validation",
  "skipped_error",
  "dry_run",
]);

const SeenTweetSchema = z.object({
  tweet_id: z.string(),
  author_handle: z.string(),
  seen_at: z.number(),
  classifier_score: z.number().nullable(),
  decision: DecisionSchema,
  reason: z.string().nullable(),
  // `seen_count` is managed by recordSeen / commitReservedLaunch (always 1
  // on first insert, +1 on each upsert) and surfaces in dashboards. Callers
  // building a SeenTweet to write should leave it unset.
  seen_count: z.number().int().min(1).default(1),
});

const LaunchRecordSchema = z.object({
  mint: z.string(),
  ticker: z.string(),
  name: z.string(),
  source_tweet_id: z.string(),
  source_author: z.string(),
  sol_spent: z.number(),
  tx_signature: z.string(),
  metadata_uri: z.string(),
  image_cid: z.string(),
  launched_at: z.number(),
  classification_reason: z.string().nullable(),
});

const DailyCounterSchema = z.object({
  date: z.string(),
  launches_count: z.number(),
  sol_spent: z.number(),
});

const XApiUsageResourceTypeSchema = z.enum(X_API_USAGE_RESOURCE_TYPES);

const XApiUsageSummaryRowSchema = z.object({
  resource_type: XApiUsageResourceTypeSchema,
  resources: z.number(),
  cost_usd: z.number(),
});

export type Decision = z.infer<typeof DecisionSchema>;
// On read (z.output) seen_count is always present; on write (z.input) it's
// optional because `.default(1)` fills it in.
export type SeenTweet = z.output<typeof SeenTweetSchema>;
export type SeenTweetInput = z.input<typeof SeenTweetSchema>;
export type LaunchRecord = z.infer<typeof LaunchRecordSchema>;
export type DailyCounter = z.infer<typeof DailyCounterSchema>;
export type XApiUsageSummaryLine = {
  resource_type: XApiUsageResourceType;
  resources: number;
  cost_usd: number;
};
export type XApiUsageTotals = {
  resources: number;
  cost_usd: number;
  by_type: XApiUsageSummaryLine[];
};
export type XApiUsageSummary = {
  date: string;
  today: XApiUsageTotals;
  total: XApiUsageTotals;
};
export type LaunchReservation = {
  date: string;
  plannedSpendSol: number;
  counter: DailyCounter;
};

function parseRow<T>(schema: z.ZodType<T>, row: unknown): T {
  const result = schema.safeParse(row);
  if (!result.success) {
    throw new Error(`DB row failed schema validation: ${result.error.message}`);
  }
  return result.data;
}

function parseRows<T>(schema: z.ZodType<T>, rows: unknown[]): T[] {
  return rows.map((row) => parseRow(schema, row));
}

export class Store {
  private db: DB;

  constructor(dbPath: string) {
    const dir = dirname(resolve(dbPath));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      // Tighten dir mode in case it pre-existed with a looser umask.
      chmodSync(dir, 0o700);
    } catch {
      /* best-effort */
    }
    this.db = new Database(dbPath);
    try {
      chmodSync(dbPath, 0o600);
    } catch {
      /* best-effort */
    }
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.applyMigrations();
  }

  private applyMigrations(): void {
    this.db.exec(SCHEMA_SQL);
    // Backfill new columns onto pre-existing tables. SQLite has no
    // "ADD COLUMN IF NOT EXISTS"; use a best-effort try/catch so a fresh DB
    // (where the column already exists from SCHEMA_SQL) is a no-op.
    try {
      this.db.exec("ALTER TABLE tweets_seen ADD COLUMN seen_count INTEGER NOT NULL DEFAULT 1");
    } catch {
      /* column already exists */
    }
  }

  hasSeen(tweetId: string): boolean {
    const row = this.db.prepare("SELECT 1 FROM tweets_seen WHERE tweet_id = ?").get(tweetId);
    return row !== undefined;
  }

  recordSeen(record: SeenTweetInput): void {
    // Bump seen_count on conflict so the dashboard can distinguish a tweet
    // we processed once from one that was force-replayed multiple times.
    this.db
      .prepare(
        `INSERT INTO tweets_seen
         (tweet_id, author_handle, seen_at, classifier_score, decision, reason, seen_count)
         VALUES (?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(tweet_id) DO UPDATE SET
           author_handle = excluded.author_handle,
           seen_at = excluded.seen_at,
           classifier_score = excluded.classifier_score,
           decision = excluded.decision,
           reason = excluded.reason,
           seen_count = seen_count + 1`,
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

  /**
   * Atomically check the daily caps and reserve a slot under the same
   * transaction that reads the counter, closing the TOCTOU window between
   * `getDailyCounter` and the launch insert. Caller follows up with
   * `commitReservedLaunch` after the SDK returns success, or with
   * `rollbackReservation` on failure.
   *
   * Returns `null` if the reservation would breach a cap.
   */
  reserveLaunchSlot(args: {
    timestampMs: number;
    plannedSpendSol: number;
    maxLaunchesPerDay: number;
    maxSolPerDay: number;
  }): LaunchReservation | null {
    const date = isoDateUtc(args.timestampMs);
    const select = this.db.prepare(
      "SELECT date, launches_count, sol_spent FROM daily_counters WHERE date = ?",
    );
    const upsert = this.db.prepare(
      `INSERT INTO daily_counters (date, launches_count, sol_spent)
       VALUES (?, 1, ?)
       ON CONFLICT(date) DO UPDATE SET
         launches_count = launches_count + 1,
         sol_spent = sol_spent + excluded.sol_spent`,
    );
    return this.db.transaction(() => {
      const raw = select.get(date);
      const before: DailyCounter = raw
        ? parseRow(DailyCounterSchema, raw)
        : { date, launches_count: 0, sol_spent: 0 };
      if (before.launches_count >= args.maxLaunchesPerDay) return null;
      if (before.sol_spent + args.plannedSpendSol > args.maxSolPerDay + FLOAT_EPS_SOL) return null;
      upsert.run(date, args.plannedSpendSol);
      return { date, plannedSpendSol: args.plannedSpendSol, counter: before };
    })();
  }

  /**
   * Roll back a previously-reserved slot. Used when the launch failed after
   * `reserveLaunchSlot` succeeded (IPFS failure, SDK failure, etc.) so the
   * cap is freed for the next tweet.
   */
  rollbackReservation(args: Pick<LaunchReservation, "date" | "plannedSpendSol">): void {
    this.db
      .prepare(
        `UPDATE daily_counters
         SET launches_count = MAX(0, launches_count - 1),
             sol_spent = MAX(0, sol_spent - ?)
         WHERE date = ?`,
      )
      .run(args.plannedSpendSol, args.date);
  }

  /**
   * Commit a launch into the DB *without* re-bumping the counter. That was
   * already done by `reserveLaunchSlot`. Instead, this reconciles the
   * conservative reservation to the measured on-chain cost so today's spend
   * reflects actual lamports spent once the launch is committed.
   */
  commitReservedLaunch(
    launch: LaunchRecord,
    seen: SeenTweetInput,
    reservation: Pick<LaunchReservation, "date" | "plannedSpendSol">,
  ): void {
    const insertLaunch = this.db.prepare(
      `INSERT INTO launches
       (mint, ticker, name, source_tweet_id, source_author, sol_spent,
        tx_signature, metadata_uri, image_cid, launched_at, classification_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const upsertSeen = this.db.prepare(
      `INSERT INTO tweets_seen
       (tweet_id, author_handle, seen_at, classifier_score, decision, reason, seen_count)
       VALUES (?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(tweet_id) DO UPDATE SET
         author_handle = excluded.author_handle,
         seen_at = excluded.seen_at,
         classifier_score = excluded.classifier_score,
         decision = excluded.decision,
         reason = excluded.reason,
         seen_count = seen_count + 1`,
    );
    const reconcileCounter = this.db.prepare(
      `UPDATE daily_counters
       SET sol_spent = MAX(0, sol_spent - ?) + ?
       WHERE date = ?`,
    );
    this.db.transaction(() => {
      insertLaunch.run(
        launch.mint,
        launch.ticker,
        launch.name,
        launch.source_tweet_id,
        launch.source_author,
        launch.sol_spent,
        launch.tx_signature,
        launch.metadata_uri,
        launch.image_cid,
        launch.launched_at,
        launch.classification_reason,
      );
      upsertSeen.run(
        seen.tweet_id,
        seen.author_handle,
        seen.seen_at,
        seen.classifier_score,
        seen.decision,
        seen.reason,
      );
      reconcileCounter.run(reservation.plannedSpendSol, launch.sol_spent, reservation.date);
    })();
  }

  getDailyCounter(timestampMs: number): DailyCounter {
    const date = isoDateUtc(timestampMs);
    const row = this.db
      .prepare("SELECT date, launches_count, sol_spent FROM daily_counters WHERE date = ?")
      .get(date);
    return row ? parseRow(DailyCounterSchema, row) : { date, launches_count: 0, sol_spent: 0 };
  }

  getCommittedDailyCounter(timestampMs: number): DailyCounter {
    const date = isoDateUtc(timestampMs);
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS launches_count, COALESCE(SUM(sol_spent), 0) AS sol_spent
         FROM launches
         WHERE substr(datetime(launched_at / 1000, 'unixepoch'), 1, 10) = ?`,
      )
      .get(date);
    const totals = z.object({ launches_count: z.number(), sol_spent: z.number() }).parse(row);
    return { date, launches_count: totals.launches_count, sol_spent: totals.sol_spent };
  }

  recordXApiUsage(args: {
    timestampMs: number;
    source: string;
    resources: readonly XApiUsageResource[];
  }): void {
    const resources = uniqueUsageResources(args.resources);
    if (resources.length === 0) return;

    const date = isoDateUtc(args.timestampMs);
    const insert = this.db.prepare(
      `INSERT INTO x_api_usage_resources
       (date, resource_type, resource_id, source, first_seen_at, last_seen_at, seen_count, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(date, resource_type, resource_id) DO UPDATE SET
         last_seen_at = excluded.last_seen_at,
         seen_count = x_api_usage_resources.seen_count + 1`,
    );

    this.db.transaction(() => {
      for (const resource of resources) {
        insert.run(
          date,
          resource.resource_type,
          resource.resource_id,
          args.source,
          args.timestampMs,
          args.timestampMs,
          resource.cost_usd,
        );
      }
    })();
  }

  getXApiUsageSummary(timestampMs: number): XApiUsageSummary {
    const date = isoDateUtc(timestampMs);
    return {
      date,
      today: this.xApiUsageTotals("WHERE date = ?", [date]),
      total: this.xApiUsageTotals("", []),
    };
  }

  lastLaunchByAuthor(authorHandle: string): LaunchRecord | null {
    const row = this.db
      .prepare("SELECT * FROM launches WHERE source_author = ? ORDER BY launched_at DESC LIMIT 1")
      .get(authorHandle);
    return row ? parseRow(LaunchRecordSchema, row) : null;
  }

  recentSeen(limit: number, offset = 0): SeenTweet[] {
    const rows = this.db
      .prepare("SELECT * FROM tweets_seen ORDER BY seen_at DESC LIMIT ? OFFSET ?")
      .all(limit, offset);
    return parseRows(SeenTweetSchema, rows);
  }

  recentLaunches(limit: number, offset = 0): LaunchRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM launches ORDER BY launched_at DESC LIMIT ? OFFSET ?")
      .all(limit, offset);
    return parseRows(LaunchRecordSchema, rows);
  }

  countSeen(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM tweets_seen").get();
    return z.object({ n: z.number() }).parse(row).n;
  }

  countLaunches(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM launches").get();
    return z.object({ n: z.number() }).parse(row).n;
  }

  getLaunch(mint: string): LaunchRecord | null {
    const row = this.db.prepare("SELECT * FROM launches WHERE mint = ?").get(mint);
    return row ? parseRow(LaunchRecordSchema, row) : null;
  }

  close(): void {
    this.db.close();
  }

  private xApiUsageTotals(whereSql: string, params: unknown[]): XApiUsageTotals {
    const rows = this.db
      .prepare(
        `SELECT resource_type, COUNT(*) AS resources, COALESCE(SUM(cost_usd), 0) AS cost_usd
         FROM x_api_usage_resources
         ${whereSql}
         GROUP BY resource_type
         ORDER BY resource_type`,
      )
      .all(...params);
    const byType = parseRows(XApiUsageSummaryRowSchema, rows);
    return {
      resources: byType.reduce((sum, row) => sum + row.resources, 0),
      cost_usd: byType.reduce((sum, row) => sum + row.cost_usd, 0),
      by_type: byType,
    };
  }
}

export function isoDateUtc(timestampMs: number): string {
  // YYYY-MM-DD in UTC, used as the daily_counters primary key.
  const d = new Date(timestampMs);
  return d.toISOString().slice(0, 10);
}
