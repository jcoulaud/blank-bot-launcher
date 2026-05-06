import type { Env } from "../config.js";
import { rootLogger } from "../logger.js";
import { evaluateCircuitBreakers } from "../safety/circuit-breaker.js";
import type { Tweet } from "../sources/tweet-source.js";
import type { PendingTweet, Store } from "../store/db.js";
import { errMsg } from "../util/errors.js";

export type PendingTweetWorker = {
  wake: () => void;
  stop: () => Promise<void>;
};

export type PendingQueueArgs = {
  env: Env;
  store: Store;
  runQueuedTweet: (tweet: Tweet) => Promise<void>;
  recordPipelineError: (tweet: Tweet, err: unknown) => void;
  staleAfterMs: number;
};

export function startPendingTweetWorker(
  args: Omit<PendingQueueArgs, "staleAfterMs"> & { circuitBreakersEnabled: boolean },
): PendingTweetWorker {
  let stopping = false;
  let wakeCurrent: (() => void) | undefined;

  const wake = () => {
    wakeCurrent?.();
    wakeCurrent = undefined;
  };

  const waitForWake = async (ms: number): Promise<void> => {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      wakeCurrent = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  };

  const loop = async () => {
    while (!stopping) {
      if (args.circuitBreakersEnabled) {
        const startedAt = Date.now();
        const breaker = evaluateCircuitBreakers({
          env: args.env,
          store: args.store,
          now: startedAt,
        });
        if (!breaker.ok) {
          args.store.recordPipelineEvent({
            stage: "circuit_breaker",
            status: "blocked",
            startedAt,
            finishedAt: Date.now(),
            detail: `${breaker.reason}: ${breaker.detail}`,
          });
          rootLogger.warn(
            { reason: breaker.reason, detail: breaker.detail },
            "circuit breaker paused queue worker",
          );
          await waitForWake(breaker.retryAfterMs);
          continue;
        }
      }

      const pending = args.store.claimNextPendingTweet(
        Date.now(),
        args.env.PENDING_LOCK_STALE_S * 1000,
      );
      if (!pending) {
        await waitForWake(1000);
        continue;
      }
      await processPendingTweet(args, pending);
    }
  };

  const loopPromise = loop();
  return {
    wake,
    stop: async () => {
      stopping = true;
      wake();
      await loopPromise;
    },
  };
}

export async function drainPendingTweets(args: PendingQueueArgs): Promise<void> {
  while (true) {
    const pending = args.store.claimNextPendingTweet(Date.now(), args.staleAfterMs);
    if (!pending) return;
    await processPendingTweet(args, pending);
  }
}

async function processPendingTweet(
  args: Omit<PendingQueueArgs, "staleAfterMs">,
  pending: PendingTweet,
): Promise<void> {
  try {
    await args.runQueuedTweet(pending.tweet);
    args.store.completePendingTweet(pending.tweet_id);
  } catch (err) {
    const now = Date.now();
    args.store.recordPipelineEvent({
      tweetId: pending.tweet.id,
      authorHandle: pending.tweet.authorHandle,
      stage: "pipeline",
      status: "error",
      startedAt: now,
      finishedAt: now,
      detail: errMsg(err),
    });
    args.recordPipelineError(pending.tweet, err);
    args.store.completePendingTweet(pending.tweet_id);
  }
}
