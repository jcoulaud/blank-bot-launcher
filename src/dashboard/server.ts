import type { Connection, Keypair } from "@solana/web3.js";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import express, { type ErrorRequestHandler, type Request, type Response } from "express";
import { getLogger } from "../logger.js";
import type { LaunchRecord, SeenTweet, Store } from "../store/db.js";

const log = getLogger({ pipeline_stage: "dashboard" });

export type DashboardOptions = {
  port: number;
  store: Store;
  connection: Connection;
  wallet: Keypair;
};

/**
 * Tiny status dashboard. Express + server-rendered HTML, no JS framework.
 * Per D7, fault-isolated: a render error returns 500 without taking down the bot.
 */
export function startDashboard(options: DashboardOptions): { close: () => Promise<void> } {
  const app = express();

  app.get("/", async (_req: Request, res: Response) => {
    const now = Date.now();
    const counter = options.store.getDailyCounter(now);
    const seen = options.store.recentSeen(50);
    const launches = options.store.recentLaunches(20);
    const balanceLamports = await options.connection.getBalance(options.wallet.publicKey);
    const balanceSol = balanceLamports / LAMPORTS_PER_SOL;

    res.type("html").send(
      renderHome({
        counter,
        seen,
        launches,
        balanceSol,
        walletPubkey: options.wallet.publicKey.toBase58(),
      }),
    );
  });

  app.get("/launches/:mint", (req: Request, res: Response) => {
    const mint = req.params.mint;
    if (typeof mint !== "string" || mint.length === 0) {
      res.status(400).type("html").send(layout("bad request", "<p>Missing mint parameter.</p>"));
      return;
    }
    const launch = options.store.getLaunch(mint);
    if (!launch) {
      res.status(404).type("html").send(layout("not found", "<p>No launch with that mint.</p>"));
      return;
    }
    res.type("html").send(renderLaunch(launch));
  });

  // Global Express error middleware (4-arg signature) — fault isolation per D7.
  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    log.error({ err: err instanceof Error ? err.message : String(err) }, "dashboard handler error");
    res
      .status(500)
      .type("html")
      .send(layout("server error", "<p>Dashboard error — see bot logs. Bot is still running.</p>"));
  };
  app.use(errorHandler);

  const server = app.listen(options.port, () => {
    log.info({ port: options.port }, "dashboard listening");
  });

  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="10">
  <title>blank-bot — ${esc(title)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; max-width: 900px; margin: 2em auto; padding: 0 1em; color: #222; }
    h1 { font-size: 1.4em; }
    h2 { font-size: 1.1em; margin-top: 2em; }
    table { border-collapse: collapse; width: 100%; }
    th, td { padding: 6px 10px; border-bottom: 1px solid #eee; text-align: left; font-size: 13px; }
    th { background: #fafafa; }
    code { background: #f4f4f4; padding: 1px 4px; border-radius: 3px; font-size: 12px; }
    .muted { color: #777; }
    .ok { color: #0a7d28; }
    .skip { color: #777; }
    .err { color: #b00020; }
  </style>
</head>
<body>${body}</body>
</html>`;
}

function renderHome(args: {
  counter: { date: string; launches_count: number; sol_spent: number };
  seen: SeenTweet[];
  launches: LaunchRecord[];
  balanceSol: number;
  walletPubkey: string;
}): string {
  const launchesRows = args.launches
    .map(
      (l) =>
        `<tr><td><a href="/launches/${esc(l.mint)}">${esc(l.ticker)}</a></td>` +
        `<td>${esc(l.name)}</td>` +
        `<td class="muted">@${esc(l.source_author)}</td>` +
        `<td class="muted">${formatTime(l.launched_at)}</td>` +
        `<td>${l.sol_spent.toFixed(4)} SOL</td></tr>`,
    )
    .join("");

  const seenRows = args.seen
    .map(
      (s) =>
        `<tr><td class="${decisionClass(s.decision)}">${esc(s.decision)}</td>` +
        `<td class="muted">@${esc(s.author_handle)}</td>` +
        `<td>${s.classifier_score?.toFixed(2) ?? "—"}</td>` +
        `<td class="muted">${formatTime(s.seen_at)}</td>` +
        `<td>${esc(s.reason ?? "")}</td></tr>`,
    )
    .join("");

  return layout(
    "status",
    `<h1>blank-bot</h1>
     <p class="muted">Wallet: <code>${esc(args.walletPubkey)}</code> · Balance: ${args.balanceSol.toFixed(4)} SOL</p>
     <p>Today (${esc(args.counter.date)}): <strong>${args.counter.launches_count}</strong> launches, <strong>${args.counter.sol_spent.toFixed(4)}</strong> SOL spent.</p>

     <h2>Recent launches</h2>
     <table><thead><tr><th>Ticker</th><th>Name</th><th>Source</th><th>When</th><th>Cost</th></tr></thead>
     <tbody>${launchesRows || `<tr><td colspan="5" class="muted">No launches yet.</td></tr>`}</tbody></table>

     <h2>Recent tweets seen</h2>
     <table><thead><tr><th>Decision</th><th>Author</th><th>Score</th><th>When</th><th>Reason</th></tr></thead>
     <tbody>${seenRows || `<tr><td colspan="5" class="muted">No tweets yet.</td></tr>`}</tbody></table>`,
  );
}

function renderLaunch(l: LaunchRecord): string {
  return layout(
    `launch ${l.ticker}`,
    `<h1>$${esc(l.ticker)} — ${esc(l.name)}</h1>
     <p class="muted">From <strong>@${esc(l.source_author)}</strong> at ${formatTime(l.launched_at)}</p>
     <p>Mint: <code>${esc(l.mint)}</code></p>
     <p>Tx: <code>${esc(l.tx_signature)}</code></p>
     <p>Cost: ${l.sol_spent.toFixed(6)} SOL</p>
     <p>Metadata: <code>${esc(l.metadata_uri)}</code></p>
     <p>Image CID: <code>${esc(l.image_cid)}</code></p>
     <p>AI reasoning: ${esc(l.ai_reasoning ?? "—")}</p>
     <p class="muted">Source tweet: <code>${esc(l.source_tweet_id)}</code></p>
     <p><a href="/">← back</a></p>`,
  );
}

function decisionClass(decision: string): string {
  if (decision === "launched") return "ok";
  if (decision.startsWith("skipped_error")) return "err";
  return "skip";
}

function formatTime(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return c;
    }
  });
}
