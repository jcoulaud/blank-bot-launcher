# Blank Bot — Design Document

**Date:** 2026-05-02
**Status:** Design validated, ready for implementation
**Repo:** open-source reference example for the [Blank.build](https://blank.build) SDK

---

## 1. Overview

`blank-bot` is an open-source TypeScript bot that watches a configured list of X (Twitter) accounts in real time, uses an LLM to decide whether each tweet is "memeable" enough to warrant a Solana memecoin, and — when the answer is yes — fully autonomously generates token metadata, prepares an image, uploads to IPFS, and launches the token via the Blank.build SDK.

Its primary purpose is **to serve as a reference implementation of the Blank SDK**, not to be a profitable trading bot. The code optimizes for clarity, forkability, and demonstrating the SDK's integration surface end-to-end.

### Goals
- Show how to integrate `blank.launch.create()` from a real autonomous service
- Be cloneable and runnable end-to-end with **only a free-tier account** at every external service
- Demonstrate sane safety patterns for a bot that signs transactions on a hot wallet
- Provide clean seams (interfaces) for forkers to swap providers (X → Nitter, Gemini → OpenAI, Pinata → Irys, etc.)

### Non-goals
- Profitable trading or alpha generation
- Multi-chain support (Solana only)
- Web UI for token management — only a tiny status dashboard
- Production-grade infra (no k8s, no horizontal scaling, no DB clustering)

---

## 2. Pipeline (high level)

```
┌──────────────┐
│ X Filtered   │
│ Stream       │ ──── tweet ────▶ [seen-tweets dedup]
└──────────────┘                          │
                                          ▼
                              ┌──────────────────────┐
                              │ Stage 1: Classifier  │ ◀── multimodal
                              │ Gemini 2.5 Flash     │     (text + images)
                              └──────────────────────┘
                                          │
                              confidence ≥ 0.85 ?
                                  │            │
                                  ▼            ▼
                                 yes           no ──▶ log + drop
                                  │
                                          ▼
                              ┌──────────────────────────┐
                              │ Stage 2: Metadata gen    │
                              │ Gemini 2.5 Flash         │
                              │ Output: name, symbol,    │
                              │   description,           │
                              │   imageStrategy          │
                              └──────────────────────────┘
                                          │
                          ┌───────────────┼────────────────┐
                          ▼               ▼                ▼
                       reuse           remix           generate
                       (download)   (Nano Banana    (Nano Banana
                                     edit mode)      text-to-image)
                          │               │                │
                          └───────────────┼────────────────┘
                                          ▼
                              ┌──────────────────────┐
                              │ Pinata: upload image │
                              │ → ipfs://<image>     │
                              └──────────────────────┘
                                          │
                                          ▼
                              ┌──────────────────────┐
                              │ Pinata: upload meta  │
                              │ JSON { name, symbol, │
                              │  description, image }│
                              │ → ipfs://<metadata>  │
                              └──────────────────────┘
                                          │
                                          ▼
                              ┌──────────────────────┐
                              │ SafetyGate           │
                              │ - per-launch cap     │
                              │ - daily SOL cap      │
                              │ - daily count cap    │
                              │ - per-author cooldown│
                              └──────────────────────┘
                                          │
                                          ▼
                              ┌──────────────────────┐
                              │ blank.launch.create()│
                              │ idempotencyKey =     │
                              │  "blank-bot-${tid}"  │
                              └──────────────────────┘
                                          │
                                          ▼
                              ┌──────────────────────┐
                              │ Persist to SQLite    │
                              │ Notify (TG + dash)   │
                              └──────────────────────┘
```

---

## 3. Architectural decisions (locked)

| # | Decision | Choice | Rationale |
|---|---|---|---|
| 1 | Autonomy mode | Fully autonomous — auto-launch | User goal; bot operates while user sleeps |
| 2 | Tweet ingestion | X API v2 Filtered Stream (pay-per-use), behind a `TweetSource` interface | Official, low-latency, no monthly minimum; interface allows forkers to swap |
| 3 | LLM provider abstraction | Vercel AI SDK | TS-native, structured-output via Zod, unifies all providers in one API |
| 4 | LLM default | Gemini 2.5 Flash (Google AI Studio free tier) | Free, multimodal (sees tweet images), structured output, fast |
| 5 | LLM pipeline | Two stages: cheap classifier → metadata generator (only on hits) | Cost control; clean filter signal for tuning |
| 6 | Image generation | Nano Banana (Gemini 2.5 Flash Image) | Same SDK as LLM, free tier, good cartoon/meme art |
| 7 | Image strategy | Reuse tweet image if present (LLM picks reuse vs remix); generate only if no image | Memes work best when grounded in original media |
| 8 | IPFS provider | Pinata | Free tier, simplest API, standard in Solana tooling |
| 9 | Wallet | Hot wallet from `.env`, hard caps in code | Realistic for autonomous bot; bounded blast radius via caps |
| 10 | Persistence | SQLite via `better-sqlite3` | Embedded, real queries, single file, scales beyond JSON-blob |
| 11 | Observability | `pino` logs + opt-in Telegram + opt-in dashboard | Logs always; rich UX off-by-default |
| 12 | Runtime | Node.js 20+ | Universal, lowest-friction "git clone, npm install, npm start" |
| 13 | Layout | Single package, folders by concern | Code structure mirrors architecture; readable |
| 14 | Tooling | `tsx` (dev), `tsc` (build), `vitest`, `biome`, strict TS, ESM, npm-compatible | Minimal, fast, mainstream |

---

## 4. Followed accounts (default)

Shipped in `accounts.example.yaml`. User copies to `accounts.yaml` (gitignored) and edits.

```yaml
# accounts.example.yaml
accounts:
  - handle: elonmusk           # tech + meme energy
  - handle: sama               # AI / OpenAI announcements
  - handle: saro               # crypto narratives
  - handle: VitalikButerin     # ETH founder, dry humor moves crypto memes
  - handle: aeyakovenko        # Solana co-founder, on-chain memes
  - handle: cz_binance         # short, market-moving
```

Six accounts is enough to demo well, small enough to fit comfortably in the X Filtered Stream rule limits (1,000 rules max on pay-per-use; we'd use 1 rule with `from:` ORs).

---

## 5. Components

### 5.1 `src/sources/tweet-source.ts` — interface

```ts
export interface Tweet {
  id: string;
  authorHandle: string;
  authorId: string;
  text: string;
  createdAt: Date;
  images: Array<{ url: string; mimeType: string }>;
  videoUrl?: string;
  isReply: boolean;
  isRetweet: boolean;
  isQuoteTweet: boolean;
  quotedTweet?: Tweet;
}

export interface TweetSource {
  start(handler: (tweet: Tweet) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
}
```

### 5.2 `src/sources/filtered-stream.ts` — default impl

- Builds a single rule: `from:elonmusk OR from:sama OR ...` (re-built when `accounts.yaml` changes)
- Connects to `GET /2/tweets/search/stream` with `expansions=author_id,attachments.media_keys&media.fields=url,type`
- Parses each delivered tweet into the `Tweet` shape
- Reconnects with exponential backoff on disconnect
- On startup, ignores tweets older than `now - 5min` to avoid stale flurries after downtime

### 5.3 `src/brain/classifier.ts` — Stage 1

Cheap pass: "is this tweet memeable?"

```ts
const Classification = z.object({
  shouldLaunch: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(200),
});

const result = await generateObject({
  model: classifierModel,        // default: gemini-2.5-flash
  schema: Classification,
  messages: [{
    role: "user",
    content: [
      { type: "text", text: classifierPrompt(tweet) },
      ...tweet.images.slice(0, 1).map(img => ({ type: "image", image: img.url })),
    ],
  }],
});
```

Drop the tweet if `!shouldLaunch || confidence < 0.85`. Always log the decision + reason to SQLite for tuning.

### 5.4 `src/brain/metadata.ts` — Stage 2

Only runs on classifier hits. Generates the actual token spec.

```ts
const Metadata = z.object({
  name: z.string().max(32),
  symbol: z.string().max(10).regex(/^[A-Z0-9]+$/),
  description: z.string().max(500),
  imageStrategy: z.enum(["reuse", "remix", "generate"]),
  imagePrompt: z.string().optional(),       // for "generate"
  remixInstructions: z.string().optional(), // for "remix"
});
```

Prompt instructs the LLM to:
- Pick a name riffing on the tweet content (≤32 bytes, NFKC-normalized)
- Pick a ticker (uppercase, ≤10 bytes, not `SOL`/`USDC`/`BLNK`)
- Decide image strategy based on whether the tweet image is meme-worthy as-is

Reserved-symbol enforcement is double-checked in code (LLM can't be trusted with hard constraints).

**Validation-failure retry contract (per D3):** post-LLM validation fails for any of:
1. name >32 bytes after NFKC normalization
2. symbol >10 bytes
3. symbol contains spaces or non-`[A-Z0-9]` chars
4. symbol is reserved (`SOL` / `USDC` / `BLNK`)
5. `imageStrategy="generate"` but `imagePrompt` missing
6. `imageStrategy="remix"` but `remixInstructions` missing or `tweet.images[0]` missing

On validation failure: re-call the metadata LLM **once** with an appended corrective hint identifying the offending field (e.g., `previous attempt failed: symbol "SOL" is reserved, pick a different one`). If the second attempt also fails validation, drop the tweet with `decision='skipped_validation'` and log the failure type for prompt tuning.

**Daily count cap accounting:** retries do **not** decrement the cap. Only successful `blank.launch.create()` returns count toward `MAX_LAUNCHES_PER_DAY`. LLM call cost is treated as cost-of-doing-business.

### 5.5 `src/brain/image.ts` — image pipeline

```ts
async function prepareImage(tweet: Tweet, meta: Metadata): Promise<Buffer> {
  if (meta.imageStrategy === "reuse" && tweet.images[0]) {
    return downloadToBuffer(tweet.images[0].url);
  }
  if (meta.imageStrategy === "remix" && tweet.images[0]) {
    const original = await downloadToBuffer(tweet.images[0].url);
    return nanoBananaEdit(original, meta.remixInstructions!);
  }
  // generate
  return nanoBananaGenerate(meta.imagePrompt!);
}
```

**Download safety (per D9):** `downloadToBuffer()` enforces a hard 5MB cap.
1. HEAD or initial GET response: reject if `Content-Length` is missing or > 5,242,880.
2. Stream body with running byte count; abort transfer + throw if it exceeds 5MB mid-download (defends against lying Content-Length).
3. Reject non-image MIME types (`Content-Type` must start with `image/`).
4. On any failure, downgrade to `imageStrategy="generate"` with `meta.imagePrompt` derived from tweet text (one re-call of the metadata LLM with a "no usable image" hint).

Videos: skip → fall back to "generate." GIFs: same — drop without first-frame extraction (per D1, `sharp` removed; first-frame extraction would reintroduce a heavy native dep). Multiple images: use `images[0]`.

### 5.6 `src/launcher/pinata.ts` — IPFS uploads

Two uploads per launch:

1. **Image upload** → returns `image_cid`
2. **Metadata JSON upload** → returns `metadata_cid`

Metadata JSON shape (per Blank's docs):
```json
{
  "name": "...",
  "symbol": "...",
  "description": "...",
  "image": "ipfs://<image_cid>"
}
```

Final `metadataUri` passed to Blank: `ipfs://<metadata_cid>` (≤72 bytes — CIDv1 base32 is 59 chars, well under).

### 5.7 `src/launcher/blank-launcher.ts` — the SDK call

```ts
const result = await blank.launch.create({
  name: meta.name,
  symbol: meta.symbol,
  metadataUri: `ipfs://${metadataCid}`,
  antiSnipeEnabled: true,
  idempotencyKey: `blank-bot-${tweet.id}`,
}, wallet);
```

`creator`, `creatorFeeSplit`, `staking` left unset (default behavior). Result is persisted to `launches` table with the full audit trail.

### 5.8 `src/launcher/safety.ts` — safety gate

Runs immediately before the SDK call. All checks must pass.

```ts
async function checkSafety(tweet: Tweet): Promise<SafetyDecision> {
  // 1. Daily count cap
  if (today.launches_count >= MAX_LAUNCHES_PER_DAY) return reject("daily_count_cap");
  // 2. Daily SOL cap
  if (today.sol_spent + plannedSpend > MAX_SOL_PER_DAY) return reject("daily_sol_cap");
  // 3. Per-launch SOL cap
  if (plannedSpend > MAX_SOL_PER_LAUNCH) return reject("per_launch_cap");
  // 4. Per-author cooldown
  const lastForAuthor = await db.lastLaunchByAuthor(tweet.authorId);
  if (lastForAuthor && now - lastForAuthor < 6h) return reject("author_cooldown");
  // 5. Wallet balance sanity
  const bal = await getWalletBalanceSol();
  if (bal > WARN_IF_BALANCE_ABOVE_SOL) logger.warn("Hot wallet over warn threshold");
  if (bal < plannedSpend) return reject("insufficient_balance");
  return accept();
}
```

`--dry-run` flag short-circuits before the SDK call (everything else still runs, including IPFS uploads, so the demo end-to-end works without spending SOL).

### 5.9 `src/store/db.ts` — SQLite

`better-sqlite3` with three tables:

```sql
CREATE TABLE tweets_seen (
  tweet_id TEXT PRIMARY KEY,
  author_handle TEXT NOT NULL,
  seen_at INTEGER NOT NULL,
  classifier_score REAL,
  decision TEXT NOT NULL,           -- 'launched' | 'skipped_low_score' | 'skipped_safety' | 'error'
  reason TEXT
);

CREATE TABLE launches (
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
CREATE INDEX idx_launches_author_time ON launches(source_author, launched_at);

CREATE TABLE daily_counters (
  date TEXT PRIMARY KEY,             -- 'YYYY-MM-DD' UTC
  launches_count INTEGER NOT NULL DEFAULT 0,
  sol_spent REAL NOT NULL DEFAULT 0
);
```

### 5.10 `src/notify/telegram.ts` — opt-in

`telegraf` with one bot token + one chat ID. Events:
- `🚀 Launched` (success): name, ticker, source link, mint address, tx link
- `🛑 Daily cap hit`
- `❌ Error`: tweet id, error class, brief

Disabled if `TELEGRAM_BOT_TOKEN` unset.

### 5.11 `src/dashboard/server.ts` — opt-in

Tiny Express app, server-rendered HTML, no JS framework. Pages:
- `/` — last 50 seen tweets with decisions, last 20 launches, daily counters, wallet balance
- `/launches/:mint` — full audit trail for one launch (tweet, classifier output, metadata gen output, image, IPFS CIDs, tx)

Auto-refresh via `<meta http-equiv="refresh" content="10">`. ~150 LOC.

Disabled if `DASHBOARD_PORT` unset.

**Fault isolation (per D7):** the dashboard runs in-process but cannot crash the bot.
- Global Express error middleware (4-arg signature) logs every handler error and returns HTTP 500 without throwing further.
- `src/index.ts` installs `process.on('uncaughtException', ...)` and `process.on('unhandledRejection', ...)` handlers that log at fatal level but **do not** call `process.exit()`. Node ≥15's default for `unhandledRejection` is to crash; we explicitly override.
- The SQLite handle is shared with the main pipeline; reads are read-only and synchronous (`better-sqlite3`) so no transactions are interrupted.

---

## 6. Configuration

### 6.1 Environment variables

```bash
# === Required ===
SOLANA_PRIVATE_KEY=                  # base58, hot wallet only
BLANK_API_KEY=                       # https://blank.build dashboard
X_API_KEY=                           # X Developer pay-per-use
X_API_SECRET=
X_BEARER_TOKEN=
GOOGLE_GENERATIVE_AI_API_KEY=        # https://aistudio.google.com (free)
PINATA_JWT=                          # https://pinata.cloud (free)

# === Optional (with defaults) ===
LLM_MODEL=gemini-2.5-flash
IMAGE_MODEL=gemini-2.5-flash-image
CLASSIFIER_THRESHOLD=0.85
PER_AUTHOR_COOLDOWN_HOURS=6
MAX_SOL_PER_LAUNCH=0.05
MAX_LAUNCHES_PER_DAY=3
MAX_SOL_PER_DAY=0.15
WARN_IF_BALANCE_ABOVE_SOL=2
RPC_URL=https://api.mainnet-beta.solana.com
ACCOUNTS_FILE=./accounts.yaml
SHUTDOWN_TIMEOUT_S=90              # graceful drain on SIGTERM/SIGINT (per D4)

# === Optional (off by default) ===
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
DASHBOARD_PORT=                      # e.g. 3000
```

### 6.2 `accounts.yaml`

See §4. User copies `accounts.example.yaml` → `accounts.yaml`, edits, restarts bot.

### 6.3 CLI flags

```
blank-bot                    # normal run
blank-bot --dry-run          # everything except SDK call
blank-bot --replay <tweetId> # replay one tweet end-to-end (dev tool)
blank-bot --check-config     # validates env, accounts, wallet balance, prints active limits
```

---

## 7. Safety model

| Concern | Mitigation |
|---|---|
| Hot wallet stolen | Caps in code limit per-launch and per-day spend regardless of balance |
| LLM hallucinates and burns money | Two-stage pipeline + 0.85 threshold; daily count cap (3) limits damage |
| Same tweet processed twice (restart, retry) | Dedup via `tweets_seen` PK + Blank's `idempotencyKey` (24h dedup) |
| Stale tweets after downtime | On startup, ignore tweets older than `now - 5min` |
| Rate cap counters lost on crash | Counters live in SQLite, not memory |
| Reserved symbols (`SOL`, `USDC`, `BLNK`) | Validated in code post-LLM, before SDK call; retries with new metadata once on conflict |
| User puts mainnet wallet with $$$ in `.env` | `WARN_IF_BALANCE_ABOVE_SOL=2` prints a loud startup banner |
| User starts bot in mainnet by mistake | Startup banner shows: network, wallet pubkey, balance, all active caps. Bot prompts to confirm if not `--yes` flag set. |

Startup banner example:
```
═══════════════════════════════════════════════
 blank-bot starting
 Network:    mainnet-beta
 Wallet:     Bx7K...ZqP3
 Balance:    0.42 SOL
 Caps:       0.05 SOL/launch · 3/day · 0.15 SOL/day
 LLM:        gemini-2.5-flash
 Image:      gemini-2.5-flash-image
 Accounts:   6 followed
 Dashboard:  http://localhost:3000
 Telegram:   enabled
 Mode:       LIVE  (use --dry-run to skip launches)
═══════════════════════════════════════════════
Press Ctrl+C within 5s to abort.
```

---

## 8. Project layout

```
blank-bot/
├── README.md
├── package.json
├── tsconfig.json
├── biome.json
├── .env.example
├── accounts.example.yaml
├── .gitignore                       # .env, accounts.yaml, data/, dist/
├── src/
│   ├── index.ts                     # entrypoint: parses CLI, wires everything, prints banner
│   ├── config.ts                    # env parsing (zod), CLI flag parsing
│   ├── logger.ts                    # pino setup
│   ├── sources/
│   │   ├── tweet-source.ts          # interface + Tweet type
│   │   ├── filtered-stream.ts       # X API v2 impl (default)
│   │   └── mock.ts                  # for tests + --replay
│   ├── brain/
│   │   ├── classifier.ts            # stage 1
│   │   ├── metadata.ts              # stage 2
│   │   ├── image.ts                 # nano banana wrappers (generate + edit)
│   │   └── prompts.ts               # all prompt templates
│   ├── launcher/
│   │   ├── pinata.ts                # IPFS uploads
│   │   ├── blank-launcher.ts        # blank.launch.create wrapper
│   │   └── safety.ts                # safety gate
│   ├── store/
│   │   ├── db.ts                    # better-sqlite3 setup + migrations
│   │   └── schema.sql
│   ├── notify/
│   │   └── telegram.ts              # telegraf, opt-in
│   └── dashboard/
│       ├── server.ts                # express, opt-in
│       └── views/                   # server-rendered HTML
├── test/
│   ├── config.test.ts               # env parsing, cross-field invariants (D5)
│   ├── classifier.test.ts           # threshold gate, multimodal message
│   ├── metadata.test.ts             # validation rules + retry contract (D3)
│   ├── image.test.ts                # branch selection, 5MB download cap (D9)
│   ├── pinata.test.ts               # multipart image + JSON metadata uploads
│   ├── blank-launcher.test.ts       # SDK wrapper, idempotencyKey, error mapping
│   ├── safety.test.ts               # all 4 caps + cooldown + balance checks
│   ├── filtered-stream.test.ts      # rule building, parser, reconnect backoff
│   ├── db.test.ts                   # migrations, counters, cooldown query
│   ├── shutdown.test.ts             # SIGTERM drain handler (D4)
│   └── pipeline.test.ts             # end-to-end mocks: dry-run, concurrency (D2), shutdown
└── data/                            # gitignored: bot.db, downloaded images cache
```

---

## 9. Stack & dependencies

```json
{
  "dependencies": {
    "@blankdotbuild/sdk": "^2.0.1",          // the whole point
    "@solana/web3.js": "^1.95",
    "ai": "^4.0",                            // Vercel AI SDK
    "@ai-sdk/google": "^1.0",                // Gemini provider
    "zod": "^3.23",
    "better-sqlite3": "^11",
    "twitter-api-v2": "^1.18",               // X API client
    "form-data": "^4",                       // Pinata multipart (still needed for FormData boundary)
    "pino": "^9",
    "pino-pretty": "^11",                    // dev only
    "telegraf": "^4.16",
    "express": "^4.21",
    "yaml": "^2.6",
    "async-mutex": "^0.5"                    // serial pipeline lock (per D2)
  },
  "devDependencies": {
    "tsx": "^4.19",
    "typescript": "^5.7",
    "vitest": "^2.1",
    "@biomejs/biome": "^1.9",
    "@types/better-sqlite3": "*",
    "@types/express": "*",
    "@types/node": "^22"
  }
}
```

Approximate total install size: ~80MB. Cold install: ~30s on a fresh machine.

---

## 10. Cost expectations (rough monthly, single-user demo)

| Service | Cost |
|---|---|
| X API (Filtered Stream, ~5–10 accounts) | $5–$30 (pay-per-use credits) |
| Gemini 2.5 Flash (LLM) | $0 (free tier covers low volume) |
| Nano Banana (image) | $0 (free tier covers low volume) |
| Pinata IPFS | $0 (free tier covers ~1GB) |
| Telegram | $0 |
| Solana fees (3 launches/day max × ~0.05 SOL each + Blank's launch fees) | depends on SOL price + Blank's fee schedule |
| **Total external services** | **~$5–$30/mo + on-chain fees** |

Anyone with a Google account, X dev account, Pinata account, and a hot wallet can run the bot end-to-end.

---

## 11. Implementation milestones

Suggested order. Every milestone ships with the corresponding test file from §8 — implementation and tests land together, not deferred. Coverage target: every branch in every module.

1. **Skeleton:** `package.json` (with `"engines": { "node": ">=20" }`), `tsconfig`, `biome`, basic `src/index.ts` with config parsing, cross-field validation (D5), and startup banner. `--check-config` works. **Tests:** `config.test.ts` covers required-field-missing, cross-field invariants, range validation per field, malformed YAML.
2. **Storage:** SQLite setup, schema, migrations. **Tests:** `db.test.ts` covers fresh-DB migration, recordSeen/recordLaunch round-trip, getDailyCounters new-day creation, lastLaunchByAuthor returns most recent.
3. **TweetSource interface + MockTweetSource:** can drive a hardcoded tweet through the pipeline.
4. **Classifier (stage 1):** wired with Vercel AI SDK + Gemini. **Tests:** `classifier.test.ts` covers happy path with mock model, image included in multimodal message, threshold gate at 0.85 (just above and just below).
5. **Metadata generator (stage 2):** typed prompt functions + few-shot in `prompts.ts` (per D6), validation + retry contract (per D3). **Tests:** `metadata.test.ts` covers happy path, reserved-symbol retry-and-succeed, name-too-long retry-and-succeed, two-consecutive-failures-drop, remix-without-image fallback.
6. **Image pipeline:** download with 5MB cap (per D9) / Nano Banana generate / Nano Banana edit. **Tests:** `image.test.ts` covers reuse, remix, generate, oversized download abort, non-image MIME reject, missing Content-Length reject.
7. **Pinata uploader:** image + metadata JSON. **Tests:** `pinata.test.ts` covers happy paths for both uploads, 4xx/5xx error mapping, CID length sanity (≤72 bytes).
8. **Safety gate:** caps + cooldown + balance checks. **Tests:** `safety.test.ts` covers each of the 5 reject reasons individually plus a clean accept path.
9. **Blank launcher:** wraps `launch.create`. **Tests:** `blank-launcher.test.ts` covers happy path with mock SDK, idempotencyKey format, antiSnipeEnabled wiring, SDK error mapping.
10. **Pipeline serialization (D2)** + **shutdown drain (D4):** `async-mutex` lock around stages 1→SDK; SIGTERM/SIGINT handler with `SHUTDOWN_TIMEOUT_S` config. **Tests:** `pipeline.test.ts` E2E with all mocks; deliver 2 tweets in 100ms verifies serial execution; `shutdown.test.ts` verifies in-flight tweet drains within timeout.
11. **FilteredStreamSource:** swap mock for real. **Tests:** `filtered-stream.test.ts` covers buildRule for N accounts (with truncation), parseTweet for image/video/quote/RT-no-comment, reconnect backoff.
12. **Telegram notifier.** Smoke test only.
13. **Dashboard** with fault isolation (per D7). Smoke test only; main risk is in process-level handlers tested in `shutdown.test.ts`.
14. **First mainnet launch:** with `MAX_SOL_PER_LAUNCH=0.001` and `MAX_LAUNCHES_PER_DAY=1`, ride a high-confidence tweet manually via `--replay`. Confirm on-chain. Then raise caps.
15. **README polish + screenshots.**

---

## 12. Open questions / future work

- **Buy-back at launch:** docs don't show `initialBuySol` in `LaunchCreateInput`. If Blank exposes a separate "first buy" path, future enhancement could be: bot launches *and* takes a small initial position. Out of scope for v1.
- **Devnet support:** Blank's docs don't clearly state devnet/testnet availability. If only mainnet is supported, `--dry-run` is the only safe rehearsal mode. Worth confirming with Blank docs/support before first real launch.
- **Multi-image tweets:** v1 uses `images[0]`. Future: LLM picks the best image of the set.
- **Reply / thread context:** v1 treats each tweet as standalone. Future: include thread parent context for the classifier.
- **Trending detection:** v1 reacts to individual tweets. Future: "is this tweet getting traction?" signal (engagement velocity) before launching.
- **Token graduation tracking:** post-launch, track which tokens graduate, surface in dashboard. Pure read-side feature.

---

## 13. README outline (for the eventual repo)

1. Hero shot (dashboard screenshot + Telegram screenshot)
2. What this is + what this isn't
3. The 60-second TL;DR of the pipeline (with the diagram from §2)
4. Quickstart: `git clone`, `npm install`, fill `.env`, copy `accounts.yaml`, `npm run dev -- --dry-run`
5. Architecture walkthrough — link to this design doc
6. Customization: swap LLM, swap tweet source, change caps
7. Safety: how to not lose money (hot wallet practices)
8. Image rights footnote
9. Contributing
10. License (MIT)

---

## 14. Eng review decisions (2026-05-02)

Logged via `/gstack-plan-eng-review`. Each decision links to the section it modifies.

| # | Topic | Choice | Affects |
|---|---|---|---|
| **D1** | Scope/deps trim | Drop `axios` (use Node fetch), drop `sharp` (no GIF support) | §5.5, §9 |
| **D2** | Concurrency | Serialize entire pipeline with `async-mutex` | §2 pipeline, §5 (new §5.12), §9 |
| **D3** | Validation retry | Retry once with corrective hint; only successes count toward daily cap | §5.4 |
| **D4** | Shutdown | SIGTERM/SIGINT drain handler with `SHUTDOWN_TIMEOUT_S=90` (default) | §5 (new in `index.ts`), §6.1 |
| **D5** | Config validation | Fail-fast on cross-field invariants with remediation message | §5 (`config.ts`), §6.1 |
| **D6** | Prompts.ts | Typed functions + 3–5 few-shot examples + `PROMPT_VERSION` comment logged on every LLM call | §5 (new §5.13), §8 layout |
| **D7** | Dashboard isolation | Express error middleware + process-level `uncaughtException`/`unhandledRejection` handlers that log without exiting | §5.11 |
| **D8** | Test plan | Expand from 3 → 11 test files; full branch coverage | §8 layout, §11 |
| **D9** | Image download cap | 5MB hard cap with header check + streaming abort + non-image MIME reject | §5.5 |

### Code-quality follow-ups noted in summary (no decision required)

- `accounts.yaml` is read once at startup; reload requires bot restart (no file-watcher).
- Logger uses pino child loggers with bound context: every pipeline log line carries `tweet_id`, `author_handle`, `pipeline_stage`.
- `SafetyDecision` typed as `Result<{ ok: true }, { ok: false; reason: RejectReason }>` where `RejectReason` is a union of the cap names.
- DRY error handling via `pipelineStep(name: string, fn: () => Promise<T>)` wrapper that standardizes the log → persist `tweets_seen` → skip-or-throw pattern.
- `package.json` adds `"engines": { "node": ">=20" }` to fail-fast on older Node.

### Architecture findings explicitly skipped

- **Tweet stream gap during disconnect** — Filtered Stream does not replay missed tweets after a reconnect; this is acceptable for a demo bot. Will be noted in README under "Limitations."
- **IPFS orphan files on crash** — image upload may complete before metadata upload writes; orphaned image CID stays on Pinata's free tier. Negligible cost, accept as-is.
- **Circuit breaker on external APIs** — overkill for ≤3 launches/day; transient failures handled by per-tweet drop, not service-level pause.

### Open questions (unchanged from §12)

The design's existing open questions stand — no TODO file created (user declined all proposed TODOs).

---

## 15. GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | not run (skipped per D10) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 9 issues, 0 critical gaps, all resolved |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | not run (no UI scope beyond a 150-LOC server-rendered dashboard) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | not run |

- **UNRESOLVED:** 0
- **VERDICT:** ENG CLEARED — design doc ready for implementation. CEO/Design/DX reviews skipped intentionally (small scope, no UI, no developer-tool surface). No outside voice — design is small + 9 issues all locked.

