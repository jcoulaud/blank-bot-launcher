import { setTimeout as sleep } from "node:timers/promises";
import { getLogger } from "../logger.js";

// Pinata V3 file upload endpoint. Both binary files and JSON metadata go
// through this single endpoint. The older /pinning/* endpoints require
// scopes that V3 keys do not carry.
// Docs: https://docs.pinata.cloud/api-reference/endpoint/upload-a-file
const PINATA_V3_UPLOAD_URL = "https://uploads.pinata.cloud/v3/files";

// Uploads are small, but TLS and Pinata processing can still take a few seconds.
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_GATEWAY_HOST = "gateway.pinata.cloud";
const DEFAULT_GATEWAY_READY_TIMEOUT_MS = 60_000;
const DEFAULT_GATEWAY_READY_POLL_MS = 2_000;

export type PinataOptions = {
  jwt: string;
  timeoutMs?: number;
};

export type MetadataAvailabilityOptions = {
  gatewayHost?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
};

/**
 * Off-chain token metadata for Solana memecoins. Uses the flat structure
 * wallets and explorers tend to display for fungible tokens.
 *
 * Fields wallets and aggregators (Phantom, Solflare, DexScreener, Birdeye,
 * Solscan, Jupiter) actually surface for fungible tokens:
 *   - name, symbol, image: universally displayed
 *   - twitter: "Twitter" link on token pages
 *   - website: "Website" link
 *   - createdOn: some explorers show the launch source
 *
 * No `description` field: the source tweet link carries the context.
 */
export type TokenMetadataJson = {
  name: string;
  symbol: string;
  image: string; // ipfs://<image_cid>
  twitter: string; // canonical link to the source tweet
  website: string; // also the tweet; gives wallets a Website button
  createdOn: string; // launcher identifier
};

export type SourceTweetForMetadata = {
  id: string;
  authorHandle: string;
};

export function buildTokenMetadata(args: {
  name: string;
  symbol: string;
  imageCid: string;
  tweet: SourceTweetForMetadata;
}): TokenMetadataJson {
  const tweetUrl = `https://x.com/${args.tweet.authorHandle}/status/${args.tweet.id}`;
  return {
    name: args.name,
    symbol: args.symbol,
    image: `ipfs://${args.imageCid}`,
    twitter: tweetUrl,
    website: tweetUrl,
    createdOn: "blank.build",
  };
}

const log = getLogger({ pipeline_stage: "pinata" });

type PinataV3UploadResponse = {
  data?: {
    id?: string;
    cid?: string;
    name?: string;
    size?: number;
    mime_type?: string;
    is_duplicate?: boolean;
  };
};

function normalizeGatewayHost(host: string): string {
  return host
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
}

/**
 * Defense-in-depth: even though SYMBOL_PATTERN already restricts symbols to
 * /^[A-Z0-9]+$/, assert that every symbol used as a filename is purely
 * alphanumeric. If a future repair path ever lets through a slash, dot, or
 * NUL, this fails loudly instead of letting it reach a Blob constructor or
 * downstream tooling that splits on path separators.
 */
export function symbolForFilename(symbol: string): string {
  const lower = symbol.toLowerCase();
  if (!/^[a-z0-9]+$/.test(lower)) {
    throw new Error(`refusing unsafe symbol for filename: ${JSON.stringify(symbol)}`);
  }
  return lower;
}

async function fetchTextWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
      redirect: "manual",
    });
  } finally {
    clearTimeout(timeout);
  }
}

function hasExpectedMetadataShape(value: unknown, expected: TokenMetadataJson): boolean {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  // Compare every field by value. Type-only checks on website/twitter would
  // accept a different gateway response served at the same CID, masking a
  // mismatch where the gateway hasn't propagated our upload yet.
  return (
    record.name === expected.name &&
    record.symbol === expected.symbol &&
    record.image === expected.image &&
    record.website === expected.website &&
    record.twitter === expected.twitter &&
    record.createdOn === expected.createdOn
  );
}

async function uploadToPinata(
  buffer: Buffer,
  filename: string,
  mimeType: string,
  options: PinataOptions,
): Promise<string> {
  // Use Web Standards FormData + Blob (built-in to Node 20+). Blob bodies
  // have a known length so undici sets Content-Length automatically;
  // stream-backed alternatives force chunked-transfer-encoding through
  // fetch + `duplex: "half"`, which Pinata sometimes 408s on.
  const form = new FormData();
  // Copy into a plain Uint8Array. Buffer's underlying ArrayBuffer can be a
  // SharedArrayBuffer in Node's types, which Blob's BlobPart type rejects.
  const bytes = new Uint8Array(buffer.byteLength);
  bytes.set(buffer);
  form.append("file", new Blob([bytes], { type: mimeType }), filename);
  form.append("network", "public");
  form.append("name", filename);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(PINATA_V3_UPLOAD_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${options.jwt}` },
      body: form,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "<no body>");
    throw new Error(`Pinata upload failed: ${response.status} ${text}`);
  }

  const json = (await response.json()) as PinataV3UploadResponse;
  const cid = json.data?.cid;
  if (!cid) {
    throw new Error(`Pinata upload returned no cid: ${JSON.stringify(json).slice(0, 300)}`);
  }
  return cid;
}

export async function uploadImage(
  buffer: Buffer,
  filename: string,
  mimeType: string,
  options: PinataOptions,
): Promise<string> {
  const cid = await uploadToPinata(buffer, filename, mimeType, options);
  log.info({ cid, bytes: buffer.length, filename }, "image pinned");
  return cid;
}

export async function uploadMetadata(
  metadata: TokenMetadataJson,
  options: PinataOptions,
): Promise<string> {
  const json = JSON.stringify(metadata);
  const safeSymbol = symbolForFilename(metadata.symbol);
  const filename = `${safeSymbol}-metadata.json`;
  const cid = await uploadToPinata(
    Buffer.from(json, "utf-8"),
    filename,
    "application/json",
    options,
  );

  // Blank caps metadataUri at 72 bytes.
  const uri = `ipfs://${cid}`;
  if (Buffer.byteLength(uri, "utf8") > 72) {
    throw new Error(`metadata URI exceeds Blank's 72-byte cap: ${uri.length} bytes (${uri})`);
  }
  log.info({ cid, uri_bytes: uri.length }, "metadata pinned");
  return cid;
}

export async function waitForMetadataAvailability(
  metadataCid: string,
  expected: TokenMetadataJson,
  options: MetadataAvailabilityOptions = {},
): Promise<string> {
  const gatewayHost = normalizeGatewayHost(options.gatewayHost ?? DEFAULT_GATEWAY_HOST);
  const gatewayUrl = `https://${gatewayHost}/ipfs/${metadataCid}`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_GATEWAY_READY_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_GATEWAY_READY_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  let last = "not attempted";

  while (Date.now() < deadline) {
    const remainingMs = Math.max(1, deadline - Date.now());
    try {
      const response = await fetchTextWithTimeout(gatewayUrl, Math.min(10_000, remainingMs));
      if (response.status >= 300 && response.status < 400) {
        last = `redirect ${response.status}`;
      } else if (!response.ok) {
        last = `HTTP ${response.status}`;
      } else {
        const text = await response.text();
        try {
          const parsed = JSON.parse(text) as unknown;
          if (hasExpectedMetadataShape(parsed, expected)) {
            log.info({ cid: metadataCid, gateway: gatewayUrl }, "metadata gateway ready");
            return gatewayUrl;
          }
          last = "metadata JSON shape mismatch";
        } catch {
          last = "invalid JSON";
        }
      }
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }

    await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
  }

  throw new Error(`metadata was not publicly readable before launch: ${gatewayUrl} (${last})`);
}
