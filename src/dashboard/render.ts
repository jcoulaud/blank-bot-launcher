import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ExternalLink } from "lucide-static";
import type { Decision, LaunchRecord, SeenTweet, XApiUsageSummary } from "../store/db.js";
import {
  X_API_PRICING_DOC_URL,
  X_API_USAGE_RESOURCE_TYPES,
  xApiUsageResourceLabel,
  xApiUsageUnitCostUsd,
} from "../util/x-api-cost.js";
import { STYLES } from "./styles.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LAMPORTS_PER_SOL_EXACT = 1_000_000_000;

const EXTERNAL_LINK_ICON = ExternalLink.replace(/\swidth="\d+"|\sheight="\d+"/g, "").replace(
  "<svg",
  '<svg width="14" height="14" aria-hidden="true"',
);

const MASCOT_RAW = readFileSync(join(__dirname, "assets/mascot.svg"), "utf8")
  .replace(/<\?xml[^?]*\?>/, "")
  .replace(/<defs>[\s\S]*?<\/defs>/, "")
  .replace(/\sclass="cls-1"/g, "")
  .trim();

const MASCOT_SVG = MASCOT_RAW.replace(
  "<svg",
  '<svg class="mascot" fill="currentColor" aria-hidden="true"',
);

// Favicon: white mascot on the dashboard's charcoal surface.
const MASCOT_INNER = MASCOT_RAW.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
const FAVICON_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">` +
  `<rect width="512" height="512" rx="96" fill="#23251d"/>` +
  `<g transform="translate(56 56) scale(0.9091)" fill="#ffffff">${MASCOT_INNER}</g>` +
  `</svg>`;
const FAVICON_DATA_URI = `data:image/svg+xml,${encodeURIComponent(FAVICON_SVG)}`;

export function layout(title: string, body: string, navMeta?: string): string {
  const meta = navMeta ? `<span class="nav-meta">${esc(navMeta)}</span>` : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="10">
  <title>Blank bot - ${esc(title)}</title>
  <link rel="icon" type="image/svg+xml" href="${FAVICON_DATA_URI}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700;800&family=Source+Code+Pro:wght@400;500&display=swap">
  <style>${STYLES}</style>
</head>
<body>
  <header class="nav">
    <a class="wordmark" href="/">${MASCOT_SVG} Blank bot</a>
    <span class="nav-spacer"></span>
    ${meta}
  </header>
  <main class="container">${body}</main>
  <footer class="footer">
    ${MASCOT_SVG}
    auto-refreshing every 10s - launcher bot example for the <a href="https://www.npmjs.com/package/@blankdotbuild/sdk" target="_blank" rel="noopener noreferrer">blank.build SDK</a>
  </footer>
</body>
</html>`;
}

export function renderHome(args: {
  counter: { date: string; launches_count: number; sol_spent: number };
  xApiUsage: XApiUsageSummary;
  openReservations?: number;
  reservedSolPending?: number;
  seen: SeenTweet[];
  seenPage: number;
  seenPageSize: number;
  seenTotal: number;
  launches: LaunchRecord[];
  launchesPage: number;
  launchesPageSize: number;
  launchesTotal: number;
  balanceSol: number;
  balanceStale?: boolean;
  walletPubkey: string;
}): string {
  const launchesRows = args.launches
    .map(
      (l) =>
        `<tr>
          <td><a class="ticker-link" href="/launches/${esc(l.mint)}">$${esc(l.ticker)}</a></td>
          <td>${esc(l.name)}</td>
          <td class="col-author">${authorTweetLink(l.source_author, l.source_tweet_id)}</td>
          <td class="col-when">${esc(formatTime(l.launched_at))}</td>
          <td class="col-num">${formatSolTwoDecimals(l.sol_spent)} SOL</td>
        </tr>`,
    )
    .join("");

  const seenRows = args.seen
    .map(
      (s) =>
        `<tr>
          <td><span class="pill ${pillClass(s.decision)}">${esc(s.decision)}</span></td>
          <td class="col-author">${authorTweetLink(s.author_handle, s.tweet_id)}</td>
          <td class="col-num">${s.classifier_score === null ? '<span class="mute">-</span>' : s.classifier_score.toFixed(2)}</td>
          <td class="col-when">${esc(formatTime(s.seen_at))}</td>
          <td class="col-reason">${esc(formatReason(s.reason))}</td>
        </tr>`,
    )
    .join("");
  const xApiCostRows = renderXApiCostRows(args.xApiUsage);

  const body = `
    <h1 class="display">Live launcher status.</h1>
    <p class="lede">Watching tweets from your followed accounts, scoring each one, and launching tokens when they clear the threshold. Wallet, today's spend, recent launches, and every tweet the bot has seen are below.</p>

    <div class="section">
      <p class="eyebrow">Wallet</p>
      <div class="card">
        <div class="block">
          <pre class="code-block code-block-with-link"><span class="code-text">${esc(args.walletPubkey)}</span><a class="code-link-inline" href="https://orbmarkets.io/address/${esc(args.walletPubkey)}" target="_blank" rel="noopener noreferrer" aria-label="Open wallet on Orb Markets" title="Open on Orb Markets">${EXTERNAL_LINK_ICON}</a></pre>
        </div>
        <div class="stats stats-dashboard">
          <div class="stat">
            <p class="stat-label">Balance</p>
            <p class="stat-value">${args.balanceSol.toFixed(2)}</p>
            <p class="stat-detail">SOL${args.balanceStale ? " (stale - RPC down)" : ""}</p>
          </div>
          <div class="stat">
            <p class="stat-label">Launches today</p>
            <p class="stat-value">${args.counter.launches_count}</p>
            <p class="stat-detail">on ${esc(args.counter.date)}${
              args.openReservations ? ` (+${args.openReservations} reserved)` : ""
            }</p>
          </div>
          <div class="stat">
            <p class="stat-label">SOL spent today</p>
            <p class="stat-value">${formatSolThreeDecimals(args.counter.sol_spent)}</p>
            <p class="stat-detail">SOL${
              args.reservedSolPending && args.reservedSolPending > 0
                ? ` (+${formatSolThreeDecimals(args.reservedSolPending)} reserved)`
                : ""
            }</p>
          </div>
          <div class="stat">
            <p class="stat-label">X API today</p>
            <p class="stat-value">${formatUsd(args.xApiUsage.today.cost_usd)}</p>
            <p class="stat-detail">${args.xApiUsage.today.resources} billable reads</p>
          </div>
        </div>
      </div>
    </div>

    <div class="section section-tight">
      <h2 class="h2" id="x-api-cost">X API estimate <a class="heading-link" href="${esc(X_API_PRICING_DOC_URL)}" target="_blank" rel="noopener noreferrer" aria-label="Open X API pricing" title="Open X API pricing">${EXTERNAL_LINK_ICON}</a></h2>
      <div class="table-card">
        <div class="table-scroll">
          <table>
            <thead><tr>
              <th>Resource</th><th class="col-num">Today</th><th class="col-num">Unit</th><th class="col-num">Today cost</th><th class="col-num">Total cost</th>
            </tr></thead>
            <tbody>${xApiCostRows}</tbody>
          </table>
        </div>
      </div>
      <p class="table-note">Standard read-rate estimate, deduplicated by resource inside each UTC day. Current billing and credit balance remain in the X Developer Console.</p>
    </div>

    <div class="section">
      <h2 class="h2" id="launches">Recent launches</h2>
      <div class="table-card">
        <div class="table-scroll">
          <table>
            <thead><tr>
              <th>Ticker</th><th>Name</th><th>Source</th><th>When</th><th class="col-num">Cost</th>
            </tr></thead>
            <tbody>${
              launchesRows ||
              `<tr><td colspan="5" class="empty">No launches yet; the bot is listening.</td></tr>`
            }</tbody>
          </table>
        </div>
        ${renderPager({
          page: args.launchesPage,
          pageSize: args.launchesPageSize,
          total: args.launchesTotal,
          param: "launches_page",
          otherParam: "seen_page",
          otherValue: args.seenPage,
          anchor: "launches",
        })}
      </div>
    </div>

    <div class="section">
      <h2 class="h2" id="tweets">Recent tweets seen</h2>
      <div class="table-card">
        <div class="table-scroll">
          <table>
            <thead><tr>
              <th>Decision</th><th>Author</th><th class="col-num">Score</th><th>When</th><th>Reason</th>
            </tr></thead>
            <tbody>${
              seenRows || `<tr><td colspan="5" class="empty">No tweets observed yet.</td></tr>`
            }</tbody>
          </table>
        </div>
        ${renderPager({
          page: args.seenPage,
          pageSize: args.seenPageSize,
          total: args.seenTotal,
          param: "seen_page",
          otherParam: "launches_page",
          otherValue: args.launchesPage,
          anchor: "tweets",
        })}
      </div>
    </div>
  `;

  return layout("status", body, `${args.counter.launches_count} launches today`);
}

export function renderLaunch(l: LaunchRecord): string {
  const reasonBanner = l.classification_reason
    ? `<div class="banner banner-note">
         <span class="banner-icon" aria-hidden="true">i</span>
         <span class="banner-label">Classifier note:</span>${esc(l.classification_reason)}
       </div>`
    : "";

  const imageUrl = `https://gateway.pinata.cloud/ipfs/${encodeURIComponent(l.image_cid)}`;

  const body = `
    <p class="eyebrow">Launched - ${esc(formatTime(l.launched_at))} - from ${authorTweetLink(l.source_author, l.source_tweet_id)}</p>
    <h1 class="display"><img class="token-avatar" src="${esc(imageUrl)}" alt="" loading="lazy">$${esc(l.ticker)} <span class="mute">- ${esc(l.name)}</span></h1>

    ${reasonBanner ? `<div class="section">${reasonBanner}</div>` : ""}

    <div class="section">
      <div class="card">
        <div class="block">
          <p class="eyebrow">Mint address</p>
          <pre class="code-block code-block-with-link"><span class="code-text">${esc(l.mint)}</span><a class="code-link-inline" href="https://orbmarkets.io/token/${esc(l.mint)}" target="_blank" rel="noopener noreferrer" aria-label="Open mint on Orb Markets" title="Open on Orb Markets">${EXTERNAL_LINK_ICON}</a></pre>
        </div>
        <div class="block">
          <p class="eyebrow">Transaction signature</p>
          <pre class="code-block code-block-with-link"><span class="code-text">${esc(l.tx_signature)}</span><a class="code-link-inline" href="https://orbmarkets.io/tx/${esc(l.tx_signature)}" target="_blank" rel="noopener noreferrer" aria-label="Open transaction on Orb Markets" title="Open on Orb Markets">${EXTERNAL_LINK_ICON}</a></pre>
        </div>
        <div class="block">
          <p class="eyebrow">Metadata URI</p>
          <pre class="code-block">${esc(l.metadata_uri)}</pre>
        </div>
        <div class="block">
          <p class="eyebrow">Image CID</p>
          <pre class="code-block">${esc(l.image_cid)}</pre>
        </div>
        <div class="block">
          <div class="stats">
            <div class="stat">
              <p class="stat-label">Cost</p>
              <p class="stat-value">${formatSol(l.sol_spent)}</p>
              <p class="stat-detail">SOL</p>
            </div>
            <div class="stat">
              <p class="stat-label">Source tweet</p>
              <p class="stat-value stat-value-sm"><a href="${esc(tweetUrl(l.source_author, l.source_tweet_id))}" target="_blank" rel="noopener noreferrer">${esc(l.source_tweet_id)}</a></p>
              <p class="stat-detail">tweet id</p>
            </div>
            <div class="stat">
              <p class="stat-label">Launched at</p>
              <p class="stat-value stat-value-sm">${esc(formatTime(l.launched_at))}</p>
              <p class="stat-detail">UTC</p>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="section">
      <a class="btn-tertiary" href="/">Back to dashboard</a>
    </div>
  `;

  return layout(`launch ${l.ticker}`, body, `$${l.ticker}`);
}

export type ErrorTone = "tip" | "warn" | "note" | "success";

export function renderError(title: string, tone: ErrorTone, message: string): string {
  const toneClass = `banner-${tone}`;
  const icon = tone === "warn" ? "!" : tone === "tip" ? "?" : tone === "success" ? "ok" : "i";
  const heading =
    title === "not found"
      ? "404 - Not found"
      : title === "bad request"
        ? "400 - Bad request"
        : title === "server error"
          ? "500 - Server error"
          : title;
  const body = `
    <p class="eyebrow">Error</p>
    <h1 class="display">${esc(heading)}</h1>
    <div class="section">
      <div class="banner ${toneClass}">
        <span class="banner-icon" aria-hidden="true">${icon}</span>${esc(message)}
      </div>
    </div>
    <div class="section">
      <a class="btn-tertiary" href="/">Back to dashboard</a>
    </div>
  `;
  return layout(title, body);
}

function renderPager(args: {
  page: number;
  pageSize: number;
  total: number;
  param: string;
  otherParam: string;
  otherValue: number;
  anchor: string;
}): string {
  if (args.total <= args.pageSize) return "";
  const lastPage = Math.max(1, Math.ceil(args.total / args.pageSize));
  const from = (args.page - 1) * args.pageSize + 1;
  const to = Math.min(args.page * args.pageSize, args.total);
  const buildHref = (p: number): string => {
    const params = new URLSearchParams();
    if (p > 1) params.set(args.param, String(p));
    if (args.otherValue > 1) params.set(args.otherParam, String(args.otherValue));
    const qs = params.toString();
    return `/${qs ? `?${qs}` : ""}#${args.anchor}`;
  };
  const prev =
    args.page > 1
      ? `<a class="pager-link" href="${esc(buildHref(args.page - 1))}" rel="prev">&larr; Prev</a>`
      : `<span class="pager-link pager-link-disabled" aria-disabled="true">&larr; Prev</span>`;
  const next =
    args.page < lastPage
      ? `<a class="pager-link" href="${esc(buildHref(args.page + 1))}" rel="next">Next &rarr;</a>`
      : `<span class="pager-link pager-link-disabled" aria-disabled="true">Next &rarr;</span>`;
  return `<div class="pager">
    <span class="pager-status">${from}&ndash;${to} of ${args.total}</span>
    <span class="pager-nav">${prev}${next}</span>
  </div>`;
}

function renderXApiCostRows(summary: XApiUsageSummary): string {
  return X_API_USAGE_RESOURCE_TYPES.map((resourceType) => {
    const today = findUsageLine(summary.today.by_type, resourceType);
    const total = findUsageLine(summary.total.by_type, resourceType);
    return `<tr>
      <td>${esc(xApiUsageResourceLabel(resourceType))}</td>
      <td class="col-num">${today.resources}</td>
      <td class="col-num">${formatUsd(xApiUsageUnitCostUsd(resourceType))}</td>
      <td class="col-num">${formatUsd(today.cost_usd)}</td>
      <td class="col-num">${formatUsd(total.cost_usd)}</td>
    </tr>`;
  }).join("");
}

function findUsageLine(
  lines: XApiUsageSummary["today"]["by_type"],
  resourceType: (typeof X_API_USAGE_RESOURCE_TYPES)[number],
): { resources: number; cost_usd: number } {
  return lines.find((line) => line.resource_type === resourceType) ?? { resources: 0, cost_usd: 0 };
}

function tweetUrl(authorHandle: string, tweetId: string): string {
  return `https://x.com/${encodeURIComponent(authorHandle)}/status/${encodeURIComponent(tweetId)}`;
}

function authorTweetLink(authorHandle: string, tweetId: string): string {
  return `<a class="author-link" href="${esc(tweetUrl(authorHandle, tweetId))}" target="_blank" rel="noopener noreferrer">@${esc(authorHandle)}</a>`;
}

// Reason cells live in a narrow table column. Keep noisy upstream errors from
// stretching the row.
export function formatReason(reason: string | null): string {
  if (!reason) return "";
  const collapsed = reason.replace(/\s+/g, " ").trim();
  const MAX = 240;
  return collapsed.length > MAX ? `${collapsed.slice(0, MAX).trimEnd()}...` : collapsed;
}

export function pillClass(decision: Decision): string {
  switch (decision) {
    case "launched":
      return "pill-launched";
    case "dry_run":
      return "pill-dry-run";
    case "skipped_low_score":
      return "pill-low";
    case "skipped_validation":
      return "pill-validation";
    case "skipped_safety":
      return "pill-safety";
    case "skipped_error":
      return "pill-error";
  }
}

function formatTime(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

export function formatSol(sol: number): string {
  if (!Number.isFinite(sol) || sol < 0) return "0";
  const lamports = Math.round(sol * LAMPORTS_PER_SOL_EXACT);
  const whole = Math.trunc(lamports / LAMPORTS_PER_SOL_EXACT);
  const fraction = lamports % LAMPORTS_PER_SOL_EXACT;
  if (fraction === 0) return `${whole}`;
  return `${whole}.${fraction.toString().padStart(9, "0").replace(/0+$/, "")}`;
}

export function formatSolTwoDecimals(sol: number): string {
  return formatSolFixed(sol, 2);
}

export function formatSolThreeDecimals(sol: number): string {
  return formatSolFixed(sol, 3);
}

function formatSolFixed(sol: number, fractionDigits: number): string {
  if (!Number.isFinite(sol) || sol < 0) return (0).toFixed(fractionDigits);
  return sol.toFixed(fractionDigits);
}

export function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "$0.00";
  const precision = value > 0 && value < 1 ? 3 : 2;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  }).format(value);
}

export function esc(s: string): string {
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
