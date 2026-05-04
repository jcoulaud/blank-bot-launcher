-- blank-bot SQLite schema (better-sqlite3, applied on startup)

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
