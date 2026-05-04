import type { Connection, Keypair } from "@solana/web3.js";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import type { Env } from "../config.js";
import { getLogger } from "../logger.js";
import type { Tweet } from "../sources/tweet-source.js";
import type { Store } from "../store/db.js";

export type RejectReason =
  | "daily_count_cap"
  | "daily_sol_cap"
  | "per_launch_cap"
  | "author_cooldown"
  | "insufficient_balance";

export type SafetyDecision =
  | { ok: true; balanceSol: number }
  | { ok: false; reason: RejectReason; detail: string };

export type SafetyContext = {
  env: Env;
  store: Store;
  connection: Connection;
  wallet: Keypair;
  plannedSpendSol: number;
  now: number; // ms epoch
};

export async function checkSafety(tweet: Tweet, ctx: SafetyContext): Promise<SafetyDecision> {
  const log = getLogger({
    tweet_id: tweet.id,
    author_handle: tweet.authorHandle,
    pipeline_stage: "safety",
  });

  const counter = ctx.store.getDailyCounter(ctx.now);

  // 1. Daily count cap
  if (counter.launches_count >= ctx.env.MAX_LAUNCHES_PER_DAY) {
    return reject(
      "daily_count_cap",
      `${counter.launches_count}/${ctx.env.MAX_LAUNCHES_PER_DAY} reached today`,
    );
  }

  // 2. Daily SOL cap
  if (counter.sol_spent + ctx.plannedSpendSol > ctx.env.MAX_SOL_PER_DAY) {
    return reject(
      "daily_sol_cap",
      `today=${counter.sol_spent} + planned=${ctx.plannedSpendSol} > cap=${ctx.env.MAX_SOL_PER_DAY}`,
    );
  }

  // 3. Per-launch SOL cap
  if (ctx.plannedSpendSol > ctx.env.MAX_SOL_PER_LAUNCH) {
    return reject(
      "per_launch_cap",
      `planned=${ctx.plannedSpendSol} > per-launch cap=${ctx.env.MAX_SOL_PER_LAUNCH}`,
    );
  }

  // 4. Per-author cooldown
  const last = ctx.store.lastLaunchByAuthor(tweet.authorHandle);
  if (last) {
    const cooldownMs = ctx.env.PER_AUTHOR_COOLDOWN_HOURS * 3_600_000;
    const sinceLast = ctx.now - last.launched_at;
    if (sinceLast < cooldownMs) {
      const remainingHours = ((cooldownMs - sinceLast) / 3_600_000).toFixed(1);
      return reject(
        "author_cooldown",
        `last launch from @${tweet.authorHandle} was ${(sinceLast / 3_600_000).toFixed(1)}h ago, cooldown ${ctx.env.PER_AUTHOR_COOLDOWN_HOURS}h, ${remainingHours}h remaining`,
      );
    }
  }

  // 5. Wallet balance sanity
  const lamports = await ctx.connection.getBalance(ctx.wallet.publicKey);
  const balanceSol = lamports / LAMPORTS_PER_SOL;
  if (balanceSol > ctx.env.WARN_IF_BALANCE_ABOVE_SOL) {
    log.warn(
      { balanceSol, threshold: ctx.env.WARN_IF_BALANCE_ABOVE_SOL },
      "hot wallet balance above WARN_IF_BALANCE_ABOVE_SOL — consider moving funds",
    );
  }
  if (balanceSol < ctx.plannedSpendSol) {
    return reject(
      "insufficient_balance",
      `wallet has ${balanceSol} SOL, need ${ctx.plannedSpendSol}`,
    );
  }

  return { ok: true, balanceSol };
}

function reject(reason: RejectReason, detail: string): SafetyDecision {
  return { ok: false, reason, detail };
}
