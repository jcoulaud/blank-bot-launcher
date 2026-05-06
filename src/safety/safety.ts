import type { Connection, Keypair } from "@solana/web3.js";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { type Env, FLOAT_EPS_SOL } from "../config.js";
import type { Store } from "../store/db.js";
import { errMsg } from "../util/errors.js";

export type RejectReason =
  | "daily_count_cap"
  | "daily_sol_cap"
  | "per_launch_cap"
  | "insufficient_balance"
  | "rpc_unavailable";

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

export type CapsContext = {
  env: Env;
  store: Store;
  plannedSpendSol: number;
  now: number;
};

/**
 * Pure (no RPC) safety gate over the configured caps. Fully unit-testable
 * without a Connection mock.
 *
 * Cap order (matters; tests pin this):
 *   1. daily count cap   - hardest stop; cheapest to check
 *   2. daily SOL cap     - aggregate spend across all today's launches
 *   3. per-launch cap    - this single launch's planned spend
 */
export function evaluateCaps(ctx: CapsContext): SafetyDecision {
  const counter = ctx.store.getDailyCounter(ctx.now);

  if (counter.launches_count >= ctx.env.MAX_LAUNCHES_PER_DAY) {
    return reject(
      "daily_count_cap",
      `${counter.launches_count}/${ctx.env.MAX_LAUNCHES_PER_DAY} reached today`,
    );
  }

  if (counter.sol_spent + ctx.plannedSpendSol > ctx.env.MAX_SOL_PER_DAY + FLOAT_EPS_SOL) {
    return reject(
      "daily_sol_cap",
      `today=${counter.sol_spent} + planned=${ctx.plannedSpendSol} > cap=${ctx.env.MAX_SOL_PER_DAY}`,
    );
  }

  if (ctx.plannedSpendSol > ctx.env.MAX_SOL_PER_LAUNCH + FLOAT_EPS_SOL) {
    return reject(
      "per_launch_cap",
      `planned=${ctx.plannedSpendSol} > per-launch cap=${ctx.env.MAX_SOL_PER_LAUNCH}`,
    );
  }

  // ok=true here just means caps passed; the caller must still check balance.
  return { ok: true, balanceSol: 0 };
}

/**
 * RPC-only step: query the wallet balance and check it against the planned
 * spend. Refuses if the RPC is down (we don't want to launch blind).
 * The balance-too-high warning lives on the startup banner; we don't
 * re-emit it per tweet here.
 */
export async function checkBalance(
  ctx: Pick<SafetyContext, "connection" | "wallet" | "plannedSpendSol">,
): Promise<SafetyDecision> {
  let lamports: number;
  try {
    lamports = await ctx.connection.getBalance(ctx.wallet.publicKey);
  } catch (err) {
    return reject("rpc_unavailable", `RPC getBalance failed: ${errMsg(err)}`);
  }
  const balanceSol = lamports / LAMPORTS_PER_SOL;
  if (balanceSol < ctx.plannedSpendSol) {
    return reject(
      "insufficient_balance",
      `wallet has ${balanceSol} SOL, need ${ctx.plannedSpendSol}`,
    );
  }
  return { ok: true, balanceSol };
}

/**
 * Composes evaluateCaps + checkBalance. Kept for callers that want a single
 * call site, including the test suite.
 */
export async function checkSafety(ctx: SafetyContext): Promise<SafetyDecision> {
  const caps = evaluateCaps(ctx);
  if (!caps.ok) return caps;
  return checkBalance(ctx);
}

function reject(reason: RejectReason, detail: string): SafetyDecision {
  return { ok: false, reason, detail };
}
