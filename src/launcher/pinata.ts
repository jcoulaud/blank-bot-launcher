import { getLogger } from "../logger.js";

// Pinata V3 file upload endpoint. Both binary files and JSON metadata go
// through this single endpoint; the legacy /pinning/* endpoints require
// V2/legacy scopes which V3 keys don't carry (returns 403 NO_SCOPES_FOUND).
// Docs: https://docs.pinata.cloud/api-reference/endpoint/upload-a-file
const PINATA_V3_UPLOAD_URL = "https://uploads.pinata.cloud/v3/files";

// Generous default — uploads are small (<5MB images, <1KB JSON) but TLS
// handshake + Pinata processing can spike to several seconds.
const DEFAULT_TIMEOUT_MS = 60_000;

export type PinataOptions = {
  jwt: string;
  timeoutMs?: number;
};

/**
 * Off-chain token metadata for memecoins. Matches the de-facto pump.fun /
 * Solana memecoin convention — flat structure, no Metaplex NFT-style nesting.
 *
 * Fields wallets and aggregators (Phantom, Solflare, DexScreener, Birdeye,
 * Solscan, Jupiter) actually surface for fungible tokens:
 *   - name, symbol, image     → universally displayed
 *   - twitter                 → "Twitter" link on token pages
 *   - website                 → "Website" link
 *   - createdOn               → some explorers show the launch source
 *
 * No `description` field by design — the source tweet IS the description for
 * a tweet-grounded memecoin, and the `twitter` field carries it directly.
 */
export type TokenMetadataJson = {
  name: string;
  symbol: string;
  image: string; // ipfs://<image_cid>
  twitter: string; // canonical link to the source tweet
  website: string; // also the tweet — gives wallets a Website button
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

async function uploadToPinata(
  buffer: Buffer,
  filename: string,
  mimeType: string,
  options: PinataOptions,
): Promise<string> {
  // Use Web Standards FormData + Blob (built-in to Node 20+, undici-native).
  // The old `form-data` package returns a Node Readable stream which forces
  // chunked-transfer-encoding through fetch + `duplex: "half"`, which Pinata
  // sometimes 408s on. Blob bodies have a known length and undici sets
  // Content-Length automatically.
  const form = new FormData();
  // Copy into a plain Uint8Array — Buffer's underlying ArrayBuffer can be a
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
  const filename = `${metadata.symbol.toLowerCase()}-metadata.json`;
  const cid = await uploadToPinata(
    Buffer.from(json, "utf-8"),
    filename,
    "application/json",
    options,
  );

  // Sanity: ipfs://<cid> must fit in Blank's 72-byte metadataUri cap.
  const uri = `ipfs://${cid}`;
  if (Buffer.byteLength(uri, "utf8") > 72) {
    throw new Error(`metadata URI exceeds Blank's 72-byte cap: ${uri.length} bytes (${uri})`);
  }
  log.info({ cid, uri_bytes: uri.length }, "metadata pinned");
  return cid;
}
