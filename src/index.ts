// Load .env into process.env before any other import touches it.
import "dotenv/config";
import { setTimeout as sleep } from "node:timers/promises";
import { google } from "@ai-sdk/google";
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { Mutex } from "async-mutex";
import bs58 from "bs58";
import { TwitterApi } from "twitter-api-v2";
import { classifyTweet, passesThreshold } from "./brain/classifier.js";
import { prepareImage } from "./brain/image.js";
import { generateTokenMetadata, type Metadata } from "./brain/metadata.js";
import { type Config, ConfigError, loadConfig } from "./config.js";
import { startDashboard } from "./dashboard/server.js";
import { type BlankClient, buildBlankClient, launchToken } from "./launcher/blank-launcher.js";
import { buildTokenMetadata, uploadImage, uploadMetadata } from "./launcher/pinata.js";
import { checkSafety } from "./launcher/safety.js";
import { getLogger, rootLogger } from "./logger.js";
import { TelegramNotifier } from "./notify/telegram.js";
import { FilteredStreamSource, parseStreamPayload } from "./sources/filtered-stream.js";
import { MockTweetSource } from "./sources/mock.js";
import type { Tweet, TweetSource } from "./sources/tweet-source.js";
import { Store } from "./store/db.js";

type CliFlags = {
  checkConfig: boolean;
  dryRun: boolean;
  replayTweetId?: string;
  yes: boolean;
  force: boolean;
};

function parseArgs(argv: string[]): CliFlags {
  const flags: CliFlags = { checkConfig: false, dryRun: false, yes: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check-config") flags.checkConfig = true;
    else if (a === "--dry-run") flags.dryRun = true;
    else if (a === "--yes" || a === "-y") flags.yes = true;
    else if (a === "--force") flags.force = true;
    else if (a === "--replay") {
      const next = argv[++i];
      if (next) flags.replayTweetId = next;
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return flags;
}

function printHelp(): void {
  console.log(`blank-bot — autonomous Solana memecoin launcher

Usage:
  blank-bot                     normal autonomous run
  blank-bot --dry-run           full pipeline, skip the SDK launch call
  blank-bot --replay <id>       fetch one tweet by id and run it through the pipeline
  blank-bot --force             bypass the dedup check and the classifier threshold
                                  (use only with --replay or --dry-run for testing)
  blank-bot --check-config      validate env, accounts, wallet balance, then exit
  blank-bot --yes               skip the 5-second confirmation banner
  blank-bot --help              this message

Environment: see .env.example
`);
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));

  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`\n${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
  const { env, accounts } = config;

  const wallet = loadKeypair(env.SOLANA_PRIVATE_KEY);
  const connection = new Connection(env.RPC_URL, "confirmed");
  const balanceLamports = await connection.getBalance(wallet.publicKey).catch(() => 0);
  const balanceSol = balanceLamports / LAMPORTS_PER_SOL;

  printBanner({ env, accounts, walletPubkey: wallet.publicKey.toBase58(), balanceSol, flags });

  if (flags.checkConfig) {
    rootLogger.info("config OK");
    process.exit(0);
  }
  if (!flags.yes && !flags.dryRun && balanceSol > 0) {
    process.stdout.write("Press Ctrl+C within 5s to abort... ");
    await sleep(5000);
    process.stdout.write("\n");
  }

  const store = new Store(env.DB_PATH);
  const llmModel = google(env.LLM_MODEL);

  const blankClient: BlankClient | null = flags.dryRun
    ? null
    : buildBlankClient({ baseUrl: env.BLANK_API_BASE_URL, apiKey: env.BLANK_API_KEY });

  const telegram =
    env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID
      ? new TelegramNotifier({ botToken: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID })
      : undefined;

  const dashboard = env.DASHBOARD_PORT
    ? startDashboard({ port: env.DASHBOARD_PORT, store, connection, wallet })
    : undefined;

  const pipelineMutex = new Mutex();
  let inFlight = 0;

  const processTweet = async (tweet: Tweet): Promise<void> => {
    // Per D2: serialize the entire pipeline. Subsequent tweets queue here.
    await pipelineMutex.runExclusive(async () => {
      inFlight = 1;
      try {
        await runPipeline(tweet, {
          env,
          store,
          connection,
          wallet,
          llmModel,
          blankClient,
          telegram,
          dryRun: flags.dryRun,
          force: flags.force,
        });
      } finally {
        inFlight = 0;
      }
    });
  };

  // Source selection: --replay short-circuits to a mock with one fetched tweet
  let source: TweetSource;
  if (flags.replayTweetId) {
    const tweet = await fetchSingleTweet(flags.replayTweetId, env.X_BEARER_TOKEN);
    if (!tweet) {
      rootLogger.error({ id: flags.replayTweetId }, "tweet not found via X API");
      process.exit(1);
    }
    const mock = new MockTweetSource();
    mock.enqueue(tweet);
    source = mock;
  } else {
    source = new FilteredStreamSource({
      bearerToken: env.X_BEARER_TOKEN,
      accounts,
      ignoreBefore: Date.now() - env.SKIP_OLDER_THAN_S * 1000,
    });
  }

  // Graceful shutdown (per D4): drain in-flight, then exit.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    rootLogger.info({ signal, in_flight: inFlight }, "shutdown initiated");
    await source
      .stop()
      .catch((err) => rootLogger.error({ err: err.message }, "source.stop failed"));

    const timeoutMs = env.SHUTDOWN_TIMEOUT_S * 1000;
    const drain = pipelineMutex.waitForUnlock();
    const result = await Promise.race([
      drain.then(() => "drained" as const),
      sleep(timeoutMs).then(() => "timeout" as const),
    ]);
    if (result === "timeout") {
      rootLogger.warn({ timeout_s: env.SHUTDOWN_TIMEOUT_S }, "shutdown timeout, forcing exit");
    }
    await dashboard
      ?.close()
      .catch((err) => rootLogger.error({ err: err.message }, "dashboard close failed"));
    store.close();
    rootLogger.info("shutdown complete");
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  // Per D7: log fatal but don't exit on uncaught — keep the bot alive.
  process.on("uncaughtException", (err) => {
    rootLogger.fatal(
      { err: err.message, stack: err.stack },
      "uncaughtException (logged, not exiting)",
    );
  });
  process.on("unhandledRejection", (reason) => {
    rootLogger.fatal({ reason: String(reason) }, "unhandledRejection (logged, not exiting)");
  });

  try {
    await source.start(processTweet);
  } catch (err) {
    if (err instanceof Error && err.name === "XStreamAccessError") {
      console.error(`\n${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  if (flags.replayTweetId) {
    // Replay completes when the mock has dispatched its queued tweet.
    rootLogger.info("replay complete");
    await shutdown("REPLAY_DONE");
  }
}

type PipelineDeps = {
  env: Config["env"];
  store: Store;
  connection: Connection;
  wallet: Keypair;
  llmModel: ReturnType<typeof google>;
  blankClient: BlankClient | null;
  telegram: TelegramNotifier | undefined;
  dryRun: boolean;
  force: boolean;
};

async function runPipeline(tweet: Tweet, deps: PipelineDeps): Promise<void> {
  const log = getLogger({ tweet_id: tweet.id, author_handle: tweet.authorHandle });
  const seenAt = Date.now();

  if (deps.store.hasSeen(tweet.id)) {
    if (deps.force) {
      log.info("already seen, but --force overrides dedup");
    } else {
      log.info("already seen, skipping (use --force to re-process)");
      return;
    }
  }

  // Stage 1 — classify
  let classification: Awaited<ReturnType<typeof classifyTweet>>;
  try {
    classification = await classifyTweet(tweet, {
      model: deps.llmModel,
      threshold: deps.env.CLASSIFIER_THRESHOLD,
    });
  } catch (err) {
    log.error({ err: errMsg(err) }, "classifier error");
    deps.store.recordSeen({
      tweet_id: tweet.id,
      author_handle: tweet.authorHandle,
      seen_at: seenAt,
      classifier_score: null,
      decision: "skipped_error",
      reason: `classifier: ${errMsg(err)}`,
    });
    return;
  }

  if (!passesThreshold(classification, deps.env.CLASSIFIER_THRESHOLD)) {
    if (deps.force) {
      log.info(
        { confidence: classification.confidence, threshold: deps.env.CLASSIFIER_THRESHOLD },
        "below threshold, but --force overrides",
      );
    } else {
      deps.store.recordSeen({
        tweet_id: tweet.id,
        author_handle: tweet.authorHandle,
        seen_at: seenAt,
        classifier_score: classification.confidence,
        decision: "skipped_low_score",
        reason: classification.reason,
      });
      return;
    }
  }

  // Stage 2 — metadata generation (with retry per D3)
  const metaResult = await generateTokenMetadata(tweet, { model: deps.llmModel });
  if (!metaResult.ok) {
    log.warn({ failure: metaResult.finalFailure }, "metadata validation failed twice");
    deps.store.recordSeen({
      tweet_id: tweet.id,
      author_handle: tweet.authorHandle,
      seen_at: seenAt,
      classifier_score: classification.confidence,
      decision: "skipped_validation",
      reason: `${metaResult.finalFailure.field}: ${metaResult.finalFailure.reason}`,
    });
    return;
  }
  const metadata: Metadata = metaResult.metadata;

  // Stage 3 — image
  let image: Awaited<ReturnType<typeof prepareImage>>;
  try {
    image = await prepareImage(tweet, metadata, {
      apiKey: deps.env.GOOGLE_GENERATIVE_AI_API_KEY,
      model: deps.env.IMAGE_MODEL,
    });
  } catch (err) {
    log.error({ err: errMsg(err) }, "image preparation failed");
    deps.store.recordSeen({
      tweet_id: tweet.id,
      author_handle: tweet.authorHandle,
      seen_at: seenAt,
      classifier_score: classification.confidence,
      decision: "skipped_error",
      reason: `image: ${errMsg(err)}`,
    });
    return;
  }

  // Safety gate
  const plannedSpend = deps.env.MAX_SOL_PER_LAUNCH;
  const safety = await checkSafety(tweet, {
    env: deps.env,
    store: deps.store,
    connection: deps.connection,
    wallet: deps.wallet,
    plannedSpendSol: plannedSpend,
    now: Date.now(),
  });
  if (!safety.ok) {
    log.info({ reason: safety.reason, detail: safety.detail }, "safety gate rejected");
    deps.store.recordSeen({
      tweet_id: tweet.id,
      author_handle: tweet.authorHandle,
      seen_at: seenAt,
      classifier_score: classification.confidence,
      decision: "skipped_safety",
      reason: `${safety.reason}: ${safety.detail}`,
    });
    if (safety.reason === "daily_count_cap" || safety.reason === "daily_sol_cap") {
      void deps.telegram?.sendCapHit(safety.detail);
    }
    return;
  }

  // IPFS uploads
  let imageCid: string;
  let metadataCid: string;
  try {
    const ext = mimeToExt(image.mimeType);
    imageCid = await uploadImage(
      image.buffer,
      `${metadata.symbol.toLowerCase()}.${ext}`,
      image.mimeType,
      { jwt: deps.env.PINATA_JWT },
    );
    metadataCid = await uploadMetadata(
      buildTokenMetadata({
        name: metadata.name,
        symbol: metadata.symbol,
        imageCid,
        tweet: { id: tweet.id, authorHandle: tweet.authorHandle },
      }),
      { jwt: deps.env.PINATA_JWT },
    );
  } catch (err) {
    log.error({ err: errMsg(err) }, "IPFS upload failed");
    deps.store.recordSeen({
      tweet_id: tweet.id,
      author_handle: tweet.authorHandle,
      seen_at: seenAt,
      classifier_score: classification.confidence,
      decision: "skipped_error",
      reason: `ipfs: ${errMsg(err)}`,
    });
    void deps.telegram?.sendError({ tweetId: tweet.id, stage: "ipfs", message: errMsg(err) });
    return;
  }

  const metadataUri = `ipfs://${metadataCid}`;

  // Launch (skipped in --dry-run)
  if (deps.dryRun || !deps.blankClient) {
    log.info(
      {
        metadata_uri: metadataUri,
        name: metadata.name,
        symbol: metadata.symbol,
        image_gateway: `https://gateway.pinata.cloud/ipfs/${imageCid}`,
        metadata_gateway: `https://gateway.pinata.cloud/ipfs/${metadataCid}`,
        dry_run: true,
      },
      `DRY RUN — would launch ${metadata.name} ($${metadata.symbol}); skipping blank.launch.create`,
    );
    deps.store.recordSeen({
      tweet_id: tweet.id,
      author_handle: tweet.authorHandle,
      seen_at: seenAt,
      classifier_score: classification.confidence,
      decision: "skipped_safety",
      reason: "dry-run",
    });
    return;
  }

  let result: Awaited<ReturnType<typeof launchToken>>;
  try {
    result = await launchToken({
      client: deps.blankClient,
      wallet: deps.wallet,
      tweet,
      metadata,
      metadataUri,
    });
  } catch (err) {
    log.error({ err: errMsg(err) }, "blank.launch.create failed");
    deps.store.recordSeen({
      tweet_id: tweet.id,
      author_handle: tweet.authorHandle,
      seen_at: seenAt,
      classifier_score: classification.confidence,
      decision: "skipped_error",
      reason: `launch: ${errMsg(err)}`,
    });
    void deps.telegram?.sendError({ tweetId: tweet.id, stage: "launch", message: errMsg(err) });
    return;
  }

  const launchedAt = Date.now();
  const txSignature = result.submission.signature;
  deps.store.recordLaunch({
    mint: result.mintAddress,
    ticker: metadata.symbol,
    name: metadata.name,
    source_tweet_id: tweet.id,
    source_author: tweet.authorHandle,
    sol_spent: plannedSpend,
    tx_signature: txSignature,
    metadata_uri: metadataUri,
    image_cid: imageCid,
    launched_at: launchedAt,
    ai_reasoning: classification.reason,
  });
  deps.store.recordSeen({
    tweet_id: tweet.id,
    author_handle: tweet.authorHandle,
    seen_at: seenAt,
    classifier_score: classification.confidence,
    decision: "launched",
    reason: classification.reason,
  });
  log.info(
    { mint: result.mintAddress, tx: txSignature, launch_id: result.launchId },
    "launch complete",
  );

  void deps.telegram?.sendLaunchSuccess({
    name: metadata.name,
    ticker: metadata.symbol,
    mint: result.mintAddress,
    txSignature,
    sourceTweetUrl: `https://twitter.com/${tweet.authorHandle}/status/${tweet.id}`,
  });
}

function loadKeypair(privateKeyEnv: string): Keypair {
  const trimmed = privateKeyEnv.trim();
  // Solana CLI keypair format: JSON array of 64 numbers
  if (trimmed.startsWith("[")) {
    const arr = JSON.parse(trimmed) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }
  // Otherwise: base58
  return Keypair.fromSecretKey(bs58.decode(trimmed));
}

async function fetchSingleTweet(id: string, bearerToken: string): Promise<Tweet | null> {
  const client = new TwitterApi(bearerToken);
  const single = await client.v2.singleTweet(id, {
    "tweet.fields": ["author_id", "created_at", "attachments", "referenced_tweets"],
    expansions: ["author_id", "attachments.media_keys", "referenced_tweets.id"],
    "media.fields": ["url", "type", "preview_image_url"],
    "user.fields": ["username"],
  });
  // Reuse the streaming parser
  return parseStreamPayload({ data: single.data, includes: single.includes } as never);
}

function printBanner(args: {
  env: Config["env"];
  accounts: Config["accounts"];
  walletPubkey: string;
  balanceSol: number;
  flags: CliFlags;
}): void {
  const { env, walletPubkey, balanceSol, flags } = args;
  const isMainnet = env.RPC_URL.includes("mainnet");
  const network = isMainnet ? "mainnet-beta" : env.RPC_URL.includes("devnet") ? "devnet" : "custom";
  const dashLine = "═".repeat(56);
  const lines = [
    dashLine,
    " blank-bot starting",
    ` Network:    ${network}`,
    ` Wallet:     ${walletPubkey.slice(0, 6)}...${walletPubkey.slice(-4)}`,
    ` Balance:    ${balanceSol.toFixed(4)} SOL`,
    ` Caps:       ${env.MAX_SOL_PER_LAUNCH} SOL/launch · ${env.MAX_LAUNCHES_PER_DAY}/day · ${env.MAX_SOL_PER_DAY} SOL/day`,
    ` LLM:        ${env.LLM_MODEL}`,
    ` Image:      ${env.IMAGE_MODEL}`,
    ` Accounts:   ${args.accounts.accounts.length} followed`,
    ` Dashboard:  ${env.DASHBOARD_PORT ? `http://localhost:${env.DASHBOARD_PORT}` : "disabled"}`,
    ` Telegram:   ${env.TELEGRAM_BOT_TOKEN ? "enabled" : "disabled"}`,
    ` Mode:       ${flags.dryRun ? "DRY-RUN  (no SDK calls)" : flags.checkConfig ? "CHECK-CONFIG" : flags.replayTweetId ? `REPLAY ${flags.replayTweetId}` : "LIVE"}${flags.force ? "  +FORCE" : ""}`,
    dashLine,
  ];
  console.log(lines.join("\n"));
  if (balanceSol > env.WARN_IF_BALANCE_ABOVE_SOL) {
    console.log(
      `WARNING: hot wallet balance (${balanceSol.toFixed(2)} SOL) exceeds ` +
        `WARN_IF_BALANCE_ABOVE_SOL=${env.WARN_IF_BALANCE_ABOVE_SOL}. Move excess to a cold wallet.`,
    );
  }
}

function mimeToExt(mime: string): string {
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/gif") return "gif";
  if (mime === "image/webp") return "webp";
  return "bin";
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

main().catch((err) => {
  rootLogger.fatal(
    {
      err: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    },
    "fatal error in main",
  );
  process.exit(1);
});
