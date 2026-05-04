import type { LaunchRecord, Store } from "../../src/store/db.js";

/**
 * Test-only helper: drives the production reserve + commit path so tests
 * exercise the same code path as live launches. Bumps the daily counter
 * and inserts a launch row (and a matching seen row) atomically.
 */
export function seedLaunch(store: Store, record: LaunchRecord): void {
  const reservation = store.reserveLaunchSlot({
    timestampMs: record.launched_at,
    plannedSpendSol: record.sol_spent,
    // Use Number.POSITIVE_INFINITY so seeding is never blocked by caps.
    maxLaunchesPerDay: Number.POSITIVE_INFINITY,
    maxSolPerDay: Number.POSITIVE_INFINITY,
  });
  if (!reservation) {
    throw new Error("seedLaunch: unexpected reservation failure under uncapped seed");
  }
  store.commitReservedLaunch(
    record,
    {
      tweet_id: record.source_tweet_id,
      author_handle: record.source_author,
      seen_at: record.launched_at,
      classifier_score: null,
      decision: "launched",
      reason: record.classification_reason,
    },
    reservation,
  );
}
