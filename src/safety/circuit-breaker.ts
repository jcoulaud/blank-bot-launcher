import type { Env } from "../config.js";
import type { PipelineEvent, Store } from "../store/db.js";

export type CircuitBreakerDecision =
  | { ok: true }
  | {
      ok: false;
      reason: "provider_errors" | "ipfs_errors" | "launch_errors" | "x_api_spend";
      detail: string;
      retryAfterMs: number;
    };

export function evaluateCircuitBreakers(args: {
  env: Env;
  store: Store;
  now: number;
}): CircuitBreakerDecision {
  const pauseMs = args.env.CIRCUIT_BREAKER_PAUSE_S * 1000;
  const recent = args.store
    .recentPipelineEvents(100)
    .filter((event) => event.finished_at >= args.now - args.env.CIRCUIT_BREAKER_WINDOW_S * 1000);

  const providerErrors = consecutiveErrors(recent, new Set(["classify", "metadata", "image"]));
  if (providerErrors >= args.env.MAX_CONSECUTIVE_PROVIDER_ERRORS) {
    return trip(
      "provider_errors",
      `${providerErrors} consecutive classifier/metadata/image errors`,
      pauseMs,
    );
  }

  const ipfsErrors = consecutiveErrors(recent, new Set(["ipfs"]));
  if (ipfsErrors >= args.env.MAX_CONSECUTIVE_IPFS_ERRORS) {
    return trip("ipfs_errors", `${ipfsErrors} consecutive IPFS errors`, pauseMs);
  }

  const launchErrors = consecutiveErrors(recent, new Set(["launch", "tx_cost"]));
  if (launchErrors >= args.env.MAX_CONSECUTIVE_LAUNCH_ERRORS) {
    return trip("launch_errors", `${launchErrors} consecutive launch/transaction errors`, pauseMs);
  }

  const xApiSpend = args.store.getXApiUsageSummary(args.now).today.cost_usd;
  if (xApiSpend >= args.env.MAX_X_API_USD_PER_DAY) {
    return trip(
      "x_api_spend",
      `estimated X API read spend ${xApiSpend.toFixed(2)} >= ${args.env.MAX_X_API_USD_PER_DAY}`,
      pauseMs,
    );
  }

  return { ok: true };
}

function consecutiveErrors(events: PipelineEvent[], stages: ReadonlySet<string>): number {
  let count = 0;
  let sawActiveError = false;
  for (const event of events) {
    if (!stages.has(event.stage)) continue;
    if (event.status === "error") {
      sawActiveError = true;
      count += 1;
      continue;
    }
    if (!sawActiveError) break;
  }
  return count;
}

function trip(
  reason: Exclude<CircuitBreakerDecision, { ok: true }>["reason"],
  detail: string,
  retryAfterMs: number,
): CircuitBreakerDecision {
  return { ok: false, reason, detail, retryAfterMs };
}
