import { createHash } from "node:crypto";
import type { Connection, Keypair } from "@solana/web3.js";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import express, {
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { getLogger } from "../logger.js";
import type { Store } from "../store/db.js";
import { errMsg } from "../util/errors.js";
import { renderError, renderHome, renderLaunch } from "./render.js";
import { STYLES } from "./styles.js";

const log = getLogger({ pipeline_stage: "dashboard" });

// 30s, deliberately longer than the dashboard's 10s meta refresh so the cache
// survives multiple reloads instead of expiring just as the next request arrives.
const BALANCE_TTL_MS = 30_000;

export type DashboardOptions = {
  port: number;
  store: Store;
  connection: Connection;
  wallet: Keypair;
};

/**
 * Tiny status dashboard. Express + server-rendered HTML, no JS framework.
 * Render failures return 500 without taking down the bot.
 *
 * Bound to 127.0.0.1, never exposed beyond loopback. The dashboard surfaces
 * the wallet pubkey, balance, and full launch history; on a shared network it
 * would leak operational state to anyone in earshot.
 */
// Hash of the inlined <style> block in render.ts. The CSP uses this hash
// instead of 'unsafe-inline' for style-src, so any other inline <style>
// (e.g. one accidentally introduced by a future template change) is
// blocked. Must match the exact bytes between `<style>` and `</style>` in
// render.ts.
const STYLE_SHA256 = createHash("sha256").update(STYLES).digest("base64");

export function startDashboard(options: DashboardOptions): { close: () => Promise<void> } {
  const app = express();
  app.disable("x-powered-by");

  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'none'",
        `style-src 'sha256-${STYLE_SHA256}' https://fonts.googleapis.com`,
        "font-src https://fonts.gstatic.com",
        "img-src 'self' data: https://gateway.pinata.cloud",
        "base-uri 'none'",
        "form-action 'none'",
      ].join("; "),
    );
    next();
  });

  let balanceCache: { sol: number; expiresAt: number; fetchedAt: number } | null = null;
  const getBalanceMemo = async (): Promise<{ sol: number; stale: boolean }> => {
    const now = Date.now();
    if (balanceCache && balanceCache.expiresAt > now) {
      return { sol: balanceCache.sol, stale: false };
    }
    try {
      const lamports = await options.connection.getBalance(options.wallet.publicKey);
      const sol = lamports / LAMPORTS_PER_SOL;
      balanceCache = { sol, expiresAt: now + BALANCE_TTL_MS, fetchedAt: now };
      return { sol, stale: false };
    } catch (err) {
      // Fall back to the last known balance so a transient RPC failure doesn't
      // 500 the dashboard. Mark stale so the UI can flag it.
      log.warn({ err: errMsg(err) }, "RPC balance fetch failed; serving cached value");
      if (balanceCache) return { sol: balanceCache.sol, stale: true };
      throw err;
    }
  };

  app.get("/", async (_req: Request, res: Response) => {
    const now = Date.now();
    const counter = options.store.getCommittedDailyCounter(now);
    // The reserved counter includes in-flight launches that haven't yet
    // committed (mid-IPFS, mid-launch). The safety gate checks against this
    // value, so the dashboard surfaces it too: an operator looking at
    // "1 launch today" should not think they have 2 free slots when one is
    // already reserved against the daily cap.
    const reserved = options.store.getDailyCounter(now);
    const openReservations = Math.max(0, reserved.launches_count - counter.launches_count);
    const reservedSolPending = Math.max(0, reserved.sol_spent - counter.sol_spent);
    const seen = options.store.recentSeen(50);
    const launches = options.store.recentLaunches(20);
    const balance = await getBalanceMemo();

    res.type("html").send(
      renderHome({
        counter,
        openReservations,
        reservedSolPending,
        seen,
        launches,
        balanceSol: balance.sol,
        balanceStale: balance.stale,
        walletPubkey: options.wallet.publicKey.toBase58(),
      }),
    );
  });

  app.get("/launches/:mint", (req: Request, res: Response) => {
    const mint = req.params.mint;
    if (typeof mint !== "string" || mint.length === 0) {
      res
        .status(400)
        .type("html")
        .send(renderError("bad request", "warn", "Missing mint parameter."));
      return;
    }
    const launch = options.store.getLaunch(mint);
    if (!launch) {
      res
        .status(404)
        .type("html")
        .send(renderError("not found", "tip", "No launch with that mint."));
      return;
    }
    res.type("html").send(renderLaunch(launch));
  });

  // Global Express error middleware keeps dashboard failures out of the bot loop.
  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    log.error({ err: errMsg(err) }, "dashboard handler error");
    res
      .status(500)
      .type("html")
      .send(
        renderError(
          "server error",
          "warn",
          "Dashboard error; see bot logs. The bot is still running.",
        ),
      );
  };
  app.use(errorHandler);

  // Bind explicitly to loopback. Never expose this dashboard on a public
  // interface. It surfaces wallet pubkey, balance, and full launch history.
  const server = app.listen(options.port, "127.0.0.1", () => {
    log.info({ port: options.port }, "dashboard listening on 127.0.0.1");
  });

  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
