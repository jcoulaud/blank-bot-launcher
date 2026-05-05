// Load .env into process.env before any other import touches it.
import "dotenv/config";
import { setTimeout as sleep } from "node:timers/promises";
import { google } from "@ai-sdk/google";
import { Connection } from "@solana/web3.js";
import { Mutex } from "async-mutex";
import { TwitterApi } from "twitter-api-v2";
import {
  type BacktestReportEntry,
  buildBacktestEntry,
  buildBacktestReport,
  defaultBacktestDbPath,
  defaultBacktestReportPath,
  writeBacktestReport,
} from "./backtest/report.js";
import { type CliFlags, CliFlagsError, loadKeypair, parseCliFlags, printHelp } from "./cli.js";
import { type Config, ConfigError, loadConfig } from "./config.js";
import { startDashboard } from "./dashboard/server.js";
import { type BlankClient, buildBlankClient } from "./launcher/blank-launcher.js";
import { getLogger, rootLogger } from "./logger.js";
import { runPipeline } from "./pipeline.js";
import { FilteredStreamSource, parseStreamPayload } from "./sources/filtered-stream.js";
import { HistoricalTimelineSource } from "./sources/historical-timeline.js";
import { MockTweetSource } from "./sources/mock.js";
import type { Tweet, TweetSource } from "./sources/tweet-source.js";
import { Store } from "./store/db.js";
import { fetchBalanceWithRetry } from "./util/balance.js";
import { printBanner } from "./util/banner.js";
import { errMsg } from "./util/errors.js";
import { type XApiUsageRecorder, xApiReadResourcesFromPayload } from "./util/x-api-cost.js";

async function main(): Promise<void> {
  let flags: CliFlags;
  try {
    flags = parseCliFlags(process.argv.slice(2));
  } catch (err) {
    if (err instanceof CliFlagsError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
  if (flags.help) {
    printHelp();
    process.exit(0);
  }

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
  const effectiveDryRun = flags.dryRun || flags.backtest || flags.dashboardOnly;
  const backtestStartedAt = new Date();

  if (flags.dashboardOnly && !env.DASHBOARD_PORT) {
    console.error(
      "\n--dashboard-only requires DASHBOARD_PORT in .env, for example DASHBOARD_PORT=3000.\n",
    );
    process.exit(1);
  }

  const wallet = loadKeypair(env.SOLANA_PRIVATE_KEY);
  const connection = new Connection(env.RPC_URL, "confirmed");
  const balanceResult = await fetchBalanceWithRetry(connection, wallet);
  const balanceSol = balanceResult.ok ? balanceResult.sol : 0;
  if (!balanceResult.ok) {
    console.error(
      `WARNING: could not query wallet balance (${balanceResult.error}). RPC may be unreachable. ` +
        `Banner shows 0 SOL but the wallet may actually be funded; verify before starting a live run.`,
    );
  }

  printBanner({ env, accounts, walletPubkey: wallet.publicKey.toBase58(), balanceSol, flags });

  if (flags.checkConfig) {
    // Fail check-config when the wallet can't fund a single launch, so an
    // empty or unreachable wallet doesn't only trip on the first live tweet.
    if (!balanceResult.ok) {
      console.error(
        "\ncheck-config FAILED: could not query wallet balance (RPC unreachable). Verify RPC_URL.\n",
      );
      process.exit(1);
    }
    if (balanceSol < env.MAX_SOL_PER_LAUNCH) {
      console.error(
        `\ncheck-config FAILED: wallet balance ${balanceSol.toFixed(4)} SOL is below ` +
          `MAX_SOL_PER_LAUNCH=${env.MAX_SOL_PER_LAUNCH}. Fund the wallet or lower the cap.\n`,
      );
      process.exit(1);
    }
    rootLogger.info("config OK");
    process.exit(0);
  }
  if (!flags.yes && !effectiveDryRun) {
    // Always prompt on a live run, even when the balance is 0 or unknown,
    // so a failed RPC lookup can never silently start the bot.
    const note = balanceResult.ok
      ? balanceSol > 0
        ? ""
        : " (wallet has 0 SOL; bot will start but every launch will fail safety)"
      : " (wallet balance unknown - RPC failed)";
    process.stdout.write(`Press Ctrl+C within 5s to abort${note}... `);
    await sleep(5000);
    process.stdout.write("\n");
  }

  const storePath = flags.backtest
    ? (flags.backtestDbPath ?? defaultBacktestDbPath(backtestStartedAt))
    : env.DB_PATH;
  const store = new Store(storePath);
  const llmModel = google(env.LLM_MODEL);
  const recordXApiUsage: XApiUsageRecorder = (resources, source) => {
    try {
      store.recordXApiUsage({
        timestampMs: Date.now(),
        source,
        resources,
      });
    } catch (err) {
      rootLogger.error({ err: errMsg(err), source }, "recordXApiUsage failed");
    }
  };

  const blankClient: BlankClient | null = effectiveDryRun
    ? null
    : buildBlankClient({ baseUrl: env.BLANK_API_BASE_URL, apiKey: env.BLANK_API_KEY });

  const dashboard = env.DASHBOARD_PORT
    ? startDashboard({
        port: env.DASHBOARD_PORT,
        store,
        connection,
        wallet,
      })
    : undefined;

  if (flags.dashboardOnly) {
    rootLogger.info(
      { port: env.DASHBOARD_PORT, db_path: storePath },
      "dashboard-only mode; skipping X source startup",
    );
    const shutdownDashboardOnly = async (signal: string) => {
      rootLogger.info({ signal }, "dashboard-only shutdown initiated");
      await dashboard
        ?.close()
        .catch((err) => rootLogger.error({ err: errMsg(err) }, "dashboard close failed"));
      try {
        store.close();
      } catch (err) {
        rootLogger.error({ err: errMsg(err) }, "store.close failed");
      }
      rootLogger.info("dashboard-only shutdown complete");
      process.exit(0);
    };
    process.on("SIGTERM", () => void shutdownDashboardOnly("SIGTERM"));
    process.on("SIGINT", () => void shutdownDashboardOnly("SIGINT"));
    await new Promise<void>(() => {
      /* keep the loopback dashboard alive until SIGINT/SIGTERM */
    });
    return;
  }

  const pipelineMutex = new Mutex();
  const backtestEntries: BacktestReportEntry[] = [];

  const processTweet = async (tweet: Tweet): Promise<void> => {
    // Serialize the launch pipeline so two tweets cannot spend against stale caps.
    const result = await pipelineMutex.runExclusive(async () => {
      return runPipeline(tweet, {
        env,
        store,
        connection,
        wallet,
        llmModel,
        blankClient,
        dryRun: effectiveDryRun,
        force: flags.force,
        backtest: flags.backtest,
      });
    });
    if (flags.backtest) backtestEntries.push(buildBacktestEntry(tweet, result));
  };

  const recordPipelineError = (tweet: Tweet, err: unknown): void => {
    try {
      store.recordSeen({
        tweet_id: tweet.id,
        author_handle: tweet.authorHandle,
        seen_at: Date.now(),
        classifier_score: null,
        decision: "skipped_error",
        reason: `pipeline_threw: ${errMsg(err)}`,
      });
    } catch (writeErr) {
      rootLogger.error(
        { err: errMsg(writeErr), tweet_id: tweet.id },
        "recordSeen failed in onPipelineError",
      );
    }
  };

  // Source selection: --replay short-circuits to a mock with one fetched tweet;
  // --backtest uses user timelines instead of the live filtered stream.
  let source: TweetSource;
  if (flags.replayTweetId) {
    const tweet = await fetchSingleTweetForReplay(
      flags.replayTweetId,
      env.X_BEARER_TOKEN,
      recordXApiUsage,
    );
    const mock = new MockTweetSource();
    mock.enqueue(tweet);
    source = mock;
  } else if (flags.backtest) {
    source = new HistoricalTimelineSource({
      bearerToken: env.X_BEARER_TOKEN,
      accounts,
      perAccountLimit: flags.backtestLimit,
      onPipelineError: recordPipelineError,
      onUsage: recordXApiUsage,
    });
  } else {
    source = new FilteredStreamSource({
      bearerToken: env.X_BEARER_TOKEN,
      accounts,
      ignoreBefore: Date.now() - env.SKIP_OLDER_THAN_S * 1000,
      onPipelineError: recordPipelineError,
      onUsage: recordXApiUsage,
    });
  }

  // Graceful shutdown: stop intake, let the active pipeline finish, then exit.
  let shuttingDown = false;
  const shutdown = async (signal: string, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    rootLogger.info({ signal, pipeline_busy: pipelineMutex.isLocked() }, "shutdown initiated");
    try {
      await source
        .stop()
        .catch((err) => rootLogger.error({ err: errMsg(err) }, "source.stop failed"));

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
        .catch((err) => rootLogger.error({ err: errMsg(err) }, "dashboard close failed"));
      try {
        store.close();
      } catch (err) {
        rootLogger.error({ err: errMsg(err) }, "store.close failed");
      }
    } catch (err) {
      rootLogger.error({ err: errMsg(err) }, "shutdown step threw");
    }
    rootLogger.info("shutdown complete");
    process.exit(exitCode);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  // Drain the in-flight pipeline before exiting so a thrown error after
  // reserveLaunchSlot but before commitReservedLaunch doesn't leave the daily
  // counter inflated. Fall back to hard-exit if shutdown itself throws.
  process.on("uncaughtException", (err) => {
    rootLogger.fatal({ err: err.message, stack: err.stack }, "uncaughtException, exiting");
    void shutdown("uncaughtException", 1).catch(() => process.exit(1));
  });
  process.on("unhandledRejection", (reason) => {
    rootLogger.fatal({ reason: String(reason) }, "unhandledRejection, exiting");
    void shutdown("unhandledRejection", 1).catch(() => process.exit(1));
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

  if (flags.backtest) {
    const report = buildBacktestReport({
      accounts,
      perAccountLimit: flags.backtestLimit,
      entries: backtestEntries,
      now: backtestStartedAt,
    });
    const reportPath = writeBacktestReport(
      flags.backtestReportPath ?? defaultBacktestReportPath(backtestStartedAt),
      report,
    );
    rootLogger.info(
      { report_path: reportPath, tweets: report.tweetsProcessed, summary: report.summary },
      "backtest complete",
    );
    console.log(
      `\nBacktest complete: ${report.tweetsProcessed} tweets processed. Report: ${reportPath}\n`,
    );
    await shutdown("BACKTEST_DONE");
  }
}

/**
 * Replay-only tweet fetch. Distinguishes "tweet does not exist" from
 * "X API call failed" so a user replaying a tweet they know exists with
 * a stale token does not chase the wrong cause.
 */
async function fetchSingleTweetForReplay(
  id: string,
  bearerToken: string,
  onUsage: XApiUsageRecorder,
): Promise<Tweet> {
  const log = getLogger({ replay_id: id });
  let tweet: Tweet | null;
  try {
    tweet = await fetchSingleTweet(id, bearerToken, onUsage);
  } catch (err) {
    log.error({ err: errMsg(err) }, "X API call failed during --replay fetch");
    console.error(`\nX API call failed: ${errMsg(err)}\nCheck X_BEARER_TOKEN and tweet id.\n`);
    process.exit(1);
  }
  if (!tweet) {
    log.error("tweet not found via X API");
    console.error(
      `\nTweet ${id} not found via X API (may be deleted, private, or never existed).\n`,
    );
    process.exit(1);
  }
  return tweet;
}

async function fetchSingleTweet(
  id: string,
  bearerToken: string,
  onUsage: XApiUsageRecorder,
): Promise<Tweet | null> {
  const client = new TwitterApi(bearerToken);
  const single = await client.v2.singleTweet(id, {
    "tweet.fields": ["author_id", "created_at", "attachments", "referenced_tweets"],
    expansions: [
      "author_id",
      "attachments.media_keys",
      "referenced_tweets.id",
      "referenced_tweets.id.author_id",
      "referenced_tweets.id.attachments.media_keys",
    ],
    "media.fields": ["url", "type", "preview_image_url"],
    "user.fields": ["username"],
  });
  onUsage(xApiReadResourcesFromPayload({ data: single.data, includes: single.includes }), "replay");
  // Reuse the streaming parser.
  return parseStreamPayload({ data: single.data, includes: single.includes });
}

main().catch((err) => {
  rootLogger.fatal(
    { err: errMsg(err), stack: err instanceof Error ? err.stack : undefined },
    "fatal error in main",
  );
  process.exit(1);
});
