// Operator-recovery tool. Use after a hard crash (SIGKILL, OOM) that may have
// killed the process between `reserveLaunchSlot` and `commitReservedLaunch`,
// leaving the daily counter ahead of the launches table.
//
// What it does: reads today's launches table count + sol_spent and overwrites
// the daily_counters row to match. Only ever runs against today's UTC date.
//
// Usage:
//   npm run reset-today                # show what would change
//   npm run reset-today -- --apply     # actually write
import "dotenv/config";
import Database from "better-sqlite3";
import { z } from "zod";
import { loadConfig } from "../src/config.js";
import { isoDateUtc } from "../src/store/db.js";

const apply = process.argv.includes("--apply");

const { env } = loadConfig();
const db = new Database(env.DB_PATH);
const today = isoDateUtc(Date.now());

const launchesRow = db
  .prepare(
    "SELECT COUNT(*) AS count, COALESCE(SUM(sol_spent), 0) AS sol_spent FROM launches " +
      "WHERE substr(datetime(launched_at/1000, 'unixepoch'), 1, 10) = ?",
  )
  .get(today);
const launches = z.object({ count: z.number(), sol_spent: z.number() }).parse(launchesRow);

const counterRow = db
  .prepare("SELECT launches_count, sol_spent FROM daily_counters WHERE date = ?")
  .get(today);
const counter = counterRow
  ? z.object({ launches_count: z.number(), sol_spent: z.number() }).parse(counterRow)
  : { launches_count: 0, sol_spent: 0 };

console.log(`date:           ${today}`);
console.log(`launches table: ${launches.count} launches, ${launches.sol_spent.toFixed(6)} SOL`);
console.log(
  `counter row:    ${counter.launches_count} launches, ${counter.sol_spent.toFixed(6)} SOL`,
);

const drift =
  counter.launches_count !== launches.count ||
  Math.abs(counter.sol_spent - launches.sol_spent) > 1e-9;

if (!drift) {
  console.log("\nNo drift detected. Counter is consistent with launches table.");
  process.exit(0);
}

console.log(
  `\nDrift detected. Counter shows ${counter.launches_count - launches.count} phantom launches and ` +
    `${(counter.sol_spent - launches.sol_spent).toFixed(6)} phantom SOL.`,
);

if (!apply) {
  console.log("\nDry run. Re-run with --apply to fix:");
  console.log("  npm run reset-today -- --apply");
  process.exit(0);
}

db.prepare(
  "INSERT INTO daily_counters (date, launches_count, sol_spent) VALUES (?, ?, ?) " +
    "ON CONFLICT(date) DO UPDATE SET launches_count = excluded.launches_count, sol_spent = excluded.sol_spent",
).run(today, launches.count, launches.sol_spent);

console.log(`\nReset. Counter for ${today} now matches launches table.`);
db.close();
