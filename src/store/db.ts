import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database, { type Database as DB } from "better-sqlite3";
import { z } from "zod";
import { FLOAT_EPS_SOL } from "../config.js";
import { type Tweet, type TweetMediaType, tweetMediaType } from "../sources/tweet-source.js";
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
  seen_count INTEGER NOT NULL DEFAULT 1,
  media_type TEXT NOT NULL DEFAULT 'unknown'
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

CREATE TABLE IF NOT EXISTS pending_tweets (
  tweet_id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  enqueued_at INTEGER NOT NULL,
  locked_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pending_tweets_ready ON pending_tweets(locked_at, enqueued_at);

CREATE TABLE IF NOT EXISTS pipeline_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tweet_id TEXT,
  author_handle TEXT,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_pipeline_events_at ON pipeline_events(finished_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_events_stage ON pipeline_events(stage, status, finished_at DESC);
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
  media_type: z.string().default("unknown"),
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

const PendingTweetRowSchema = z.object({
  tweet_id: z.string(),
  payload_json: z.string(),
  enqueued_at: z.number(),
  locked_at: z.number().nullable(),
  attempts: z.number().int().min(0),
});

const PipelineEventSchema = z.object({
  id: z.number().int(),
  tweet_id: z.string().nullable(),
  author_handle: z.string().nullable(),
  stage: z.string(),
  status: z.enum(["ok", "skipped", "blocked", "error"]),
  started_at: z.number(),
  finished_at: z.number(),
  duration_ms: z.number(),
  detail: z.string().nullable(),
});

const StageMetricRowSchema = z.object({
  stage: z.string(),
  runs: z.number(),
  errors: z.number(),
  avg_duration_ms: z.number(),
  max_duration_ms: z.number(),
});

const DecisionCountRowSchema = z.object({
  decision: z.string(),
  count: z.number(),
});

const ScoreBucketRowSchema = z.object({
  bucket: z.string(),
  count: z.number(),
});

const AccountDecisionRowSchema = z.object({
  author_handle: z.string(),
  total: z.number(),
  launched: z.number(),
  dry_run: z.number(),
  skipped: z.number(),
  avg_score: z.number().nullable(),
});

const MediaDecisionRowSchema = z.object({
  media_type: z.string(),
  total: z.number(),
  launched: z.number(),
  dry_run: z.number(),
  skipped: z.number(),
});

export type Decision = z.infer<typeof DecisionSchema>;
// On read (z.output) seen_count is always present; on write (z.input) it's
// optional because `.default(1)` fills it in.
export type SeenTweet = z.output<typeof SeenTweetSchema>;
export type SeenTweetInput = z.input<typeof SeenTweetSchema>;
export type LaunchRecord = z.infer<typeof LaunchRecordSchema>;
export type DailyCounter = z.infer<typeof DailyCounterSchema>;
export type PendingTweet = z.infer<typeof PendingTweetRowSchema> & { tweet: Tweet };
export type PipelineEvent = z.infer<typeof PipelineEventSchema>;
export type PipelineEventStatus = PipelineEvent["status"];
export type DashboardTelemetry = {
  stageMetrics: Array<z.infer<typeof StageMetricRowSchema>>;
  decisionCounts: Array<z.infer<typeof DecisionCountRowSchema>>;
  scoreBuckets: Array<z.infer<typeof ScoreBucketRowSchema>>;
  accountStats: Array<z.infer<typeof AccountDecisionRowSchema>>;
  mediaStats: Array<z.infer<typeof MediaDecisionRowSchema>>;
  recentErrors: PipelineEvent[];
  pending: {
    queued: number;
    locked: number;
  };
};
export type LaunchTotals = {
  launches_count: number;
  sol_spent: number;
};
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
    try {
      this.db.exec("ALTER TABLE tweets_seen ADD COLUMN media_type TEXT NOT NULL DEFAULT 'unknown'");
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
         (tweet_id, author_handle, seen_at, classifier_score, decision, reason, seen_count, media_type)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(tweet_id) DO UPDATE SET
           author_handle = excluded.author_handle,
           seen_at = excluded.seen_at,
           classifier_score = excluded.classifier_score,
           decision = excluded.decision,
           reason = excluded.reason,
           media_type = excluded.media_type,
           seen_count = seen_count + 1`,
      )
      .run(
        record.tweet_id,
        record.author_handle,
        record.seen_at,
        record.classifier_score,
        record.decision,
        record.reason,
        record.media_type ?? "unknown",
      );
  }

  enqueuePendingTweet(tweet: Tweet, timestampMs = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO pending_tweets
         (tweet_id, payload_json, enqueued_at, locked_at, attempts)
         VALUES (?, ?, ?, NULL, 0)
         ON CONFLICT(tweet_id) DO UPDATE SET
           payload_json = excluded.payload_json`,
      )
      .run(tweet.id, JSON.stringify(tweetToJson(tweet)), timestampMs);
  }

  claimNextPendingTweet(timestampMs: number, staleAfterMs: number): PendingTweet | null {
    const staleBefore = timestampMs - staleAfterMs;
    const select = this.db.prepare(
      `SELECT *
       FROM pending_tweets
       WHERE locked_at IS NULL OR locked_at <= ?
       ORDER BY enqueued_at ASC, rowid ASC
       LIMIT 1`,
    );
    const lock = this.db.prepare(
      `UPDATE pending_tweets
       SET locked_at = ?, attempts = attempts + 1
       WHERE tweet_id = ?`,
    );
    return this.db.transaction(() => {
      const raw = select.get(staleBefore);
      if (!raw) return null;
      const before = parseRow(PendingTweetRowSchema, raw);
      lock.run(timestampMs, before.tweet_id);
      const updated = { ...before, locked_at: timestampMs, attempts: before.attempts + 1 };
      return { ...updated, tweet: tweetFromJson(JSON.parse(updated.payload_json)) };
    })();
  }

  completePendingTweet(tweetId: string): void {
    this.db.prepare("DELETE FROM pending_tweets WHERE tweet_id = ?").run(tweetId);
  }

  pendingSummary(): DashboardTelemetry["pending"] {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS queued,
           SUM(CASE WHEN locked_at IS NOT NULL THEN 1 ELSE 0 END) AS locked
         FROM pending_tweets`,
      )
      .get();
    return z
      .object({
        queued: z.number(),
        locked: z.number().nullable(),
      })
      .transform((value) => ({
        queued: value.queued,
        locked: value.locked ?? 0,
      }))
      .parse(row);
  }

  recordPipelineEvent(event: {
    tweetId?: string;
    authorHandle?: string;
    stage: string;
    status: PipelineEventStatus;
    startedAt: number;
    finishedAt: number;
    detail?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO pipeline_events
         (tweet_id, author_handle, stage, status, started_at, finished_at, duration_ms, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.tweetId ?? null,
        event.authorHandle ?? null,
        event.stage,
        event.status,
        event.startedAt,
        event.finishedAt,
        Math.max(0, event.finishedAt - event.startedAt),
        event.detail ?? null,
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
       (tweet_id, author_handle, seen_at, classifier_score, decision, reason, seen_count, media_type)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(tweet_id) DO UPDATE SET
         author_handle = excluded.author_handle,
         seen_at = excluded.seen_at,
         classifier_score = excluded.classifier_score,
         decision = excluded.decision,
         reason = excluded.reason,
         media_type = excluded.media_type,
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
        seen.media_type ?? "unknown",
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

  getLaunchTotals(): LaunchTotals {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS launches_count, COALESCE(SUM(sol_spent), 0) AS sol_spent FROM launches",
      )
      .get();
    return z.object({ launches_count: z.number(), sol_spent: z.number() }).parse(row);
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

  recentPipelineEvents(limit: number, statuses?: readonly PipelineEventStatus[]): PipelineEvent[] {
    const statusList = statuses?.length ? statuses : undefined;
    const where = statusList ? `WHERE status IN (${statusList.map(() => "?").join(", ")})` : "";
    const rows = this.db
      .prepare(`SELECT * FROM pipeline_events ${where} ORDER BY finished_at DESC LIMIT ?`)
      .all(...(statusList ?? []), limit);
    return parseRows(PipelineEventSchema, rows);
  }

  dashboardTelemetry(): DashboardTelemetry {
    const stageRows = this.db
      .prepare(
        `SELECT
           stage,
           COUNT(*) AS runs,
           SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
           COALESCE(AVG(duration_ms), 0) AS avg_duration_ms,
           COALESCE(MAX(duration_ms), 0) AS max_duration_ms
         FROM pipeline_events
         GROUP BY stage
         ORDER BY stage`,
      )
      .all();
    const decisionRows = this.db
      .prepare(
        `SELECT decision, COUNT(*) AS count
         FROM tweets_seen
         GROUP BY decision
         ORDER BY count DESC, decision`,
      )
      .all();
    const scoreRows = this.db
      .prepare(
        `SELECT
           CASE
             WHEN classifier_score IS NULL THEN 'none'
             WHEN classifier_score < 0.5 THEN '<0.50'
             WHEN classifier_score < 0.7 THEN '0.50-0.69'
             WHEN classifier_score < 0.85 THEN '0.70-0.84'
             WHEN classifier_score < 0.95 THEN '0.85-0.94'
             ELSE '>=0.95'
           END AS bucket,
           COUNT(*) AS count
         FROM tweets_seen
         GROUP BY bucket
         ORDER BY
           CASE bucket
             WHEN 'none' THEN 0
             WHEN '<0.50' THEN 1
             WHEN '0.50-0.69' THEN 2
             WHEN '0.70-0.84' THEN 3
             WHEN '0.85-0.94' THEN 4
             ELSE 5
           END`,
      )
      .all();
    const accountRows = this.db
      .prepare(
        `SELECT
           author_handle,
           COUNT(*) AS total,
           SUM(CASE WHEN decision = 'launched' THEN 1 ELSE 0 END) AS launched,
           SUM(CASE WHEN decision = 'dry_run' THEN 1 ELSE 0 END) AS dry_run,
           SUM(CASE WHEN decision NOT IN ('launched', 'dry_run') THEN 1 ELSE 0 END) AS skipped,
           AVG(classifier_score) AS avg_score
         FROM tweets_seen
         GROUP BY author_handle
         ORDER BY total DESC, author_handle
         LIMIT 12`,
      )
      .all();
    const mediaRows = this.db
      .prepare(
        `SELECT
           media_type,
           COUNT(*) AS total,
           SUM(CASE WHEN decision = 'launched' THEN 1 ELSE 0 END) AS launched,
           SUM(CASE WHEN decision = 'dry_run' THEN 1 ELSE 0 END) AS dry_run,
           SUM(CASE WHEN decision NOT IN ('launched', 'dry_run') THEN 1 ELSE 0 END) AS skipped
         FROM tweets_seen
         GROUP BY media_type
         ORDER BY total DESC, media_type`,
      )
      .all();

    return {
      stageMetrics: parseRows(StageMetricRowSchema, stageRows),
      decisionCounts: parseRows(DecisionCountRowSchema, decisionRows),
      scoreBuckets: parseRows(ScoreBucketRowSchema, scoreRows),
      accountStats: parseRows(AccountDecisionRowSchema, accountRows),
      mediaStats: parseRows(MediaDecisionRowSchema, mediaRows),
      recentErrors: this.recentPipelineEvents(10, ["error", "blocked"]),
      pending: this.pendingSummary(),
    };
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

type JsonTweet = Omit<Tweet, "createdAt" | "quotedTweet"> & {
  createdAt: string;
  quotedTweet?: JsonTweet;
};

function tweetToJson(tweet: Tweet): JsonTweet {
  const out: JsonTweet = {
    id: tweet.id,
    authorHandle: tweet.authorHandle,
    authorId: tweet.authorId,
    text: tweet.text,
    createdAt: tweet.createdAt.toISOString(),
    media: tweet.media,
    images: tweet.images,
    isReply: tweet.isReply,
    isRetweet: tweet.isRetweet,
    isQuoteTweet: tweet.isQuoteTweet,
  };
  if (tweet.quotedTweet) out.quotedTweet = tweetToJson(tweet.quotedTweet);
  return out;
}

function tweetFromJson(value: unknown): Tweet {
  const raw = value as Partial<JsonTweet>;
  if (
    !raw ||
    typeof raw !== "object" ||
    typeof raw.id !== "string" ||
    typeof raw.authorHandle !== "string" ||
    typeof raw.authorId !== "string" ||
    typeof raw.text !== "string" ||
    typeof raw.createdAt !== "string" ||
    !Array.isArray(raw.media) ||
    !Array.isArray(raw.images) ||
    typeof raw.isReply !== "boolean" ||
    typeof raw.isRetweet !== "boolean" ||
    typeof raw.isQuoteTweet !== "boolean"
  ) {
    throw new Error("pending tweet payload failed validation");
  }
  const tweet: Tweet = {
    id: raw.id,
    authorHandle: raw.authorHandle,
    authorId: raw.authorId,
    text: raw.text,
    createdAt: new Date(raw.createdAt),
    media: raw.media,
    images: raw.images,
    isReply: raw.isReply,
    isRetweet: raw.isRetweet,
    isQuoteTweet: raw.isQuoteTweet,
  };
  if (raw.quotedTweet) tweet.quotedTweet = tweetFromJson(raw.quotedTweet);
  return tweet;
}

export function mediaTypeForSeen(tweet: Tweet): TweetMediaType {
  return tweetMediaType(tweet);
}
