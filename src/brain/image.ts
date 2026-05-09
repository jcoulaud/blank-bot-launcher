import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { getLogger } from "../logger.js";
import {
  getPrimaryLaunchImage,
  getPrimaryLaunchImageSource,
  type Tweet,
} from "../sources/tweet-source.js";
import { errMsg } from "../util/errors.js";
import { ALLOWED_IMAGE_HOSTS } from "../util/x-hosts.js";
import type { ImageStyle, Metadata } from "./metadata.js";

const MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const SAFE_FALLBACK_IMAGE_STYLE =
  "safe abstract token-avatar icon, one distinctive non-human subject or symbolic object, strong silhouette, simple high-contrast background, no public figures, no real people, no copyrighted characters, no violence, no political symbols";
const CRYPTO_NATIVE_IMAGE_RULES =
  "Make the visual language crypto-native and trench-native: raw meme edit, sticker, reaction persona, degen artifact, lore object, rough sketch, pixel item, ugly-funny emblem, or cursed-clean 3D object when it fits the tweet. Avoid stale bull-market cliches unless the tweet itself specifically demands them: rockets, moons, laser eyes, diamond hands, coin piles, Lambos, WAGMI banners, glossy token logos, floating chrome brains, neural-net diagrams, and generic cyber circuit boards.";
const FRAMING_RULES =
  "OUTPUT FORMAT: a square 1:1 memecoin token avatar designed to stay recognizable at 32x32 pixels in token lists and wallet UIs. Composition: ONE main subject only, centered, occupying 70-90% of the canvas, with a strong readable silhouette. The style can be photographic, 3D, graphic, pixel, surreal, painterly, or drawn when requested. Background: simple, high-contrast, edge-to-edge, and subordinate to the subject; no busy scenery or multi-object scenes. The image MUST NOT contain ANY of: panels, comic gutters, frame lines, outer borders, mattes, vignettes, letterbox bars, padding, margins, caption strips, banner ribbons, title cards, name plates, speech bubbles, watermarks, signatures, logos, words, letters, numbers, or any kind of writing, lettering, or text whatsoever, anywhere in the image, in any language, including stylized graffiti or background text.";
const IMAGE_STYLE_PROMPTS: Record<ImageStyle, string> = {
  "meme-character":
    "internet meme character avatar: simplified expressive character or mascot, bold readable shapes, cartoon treatment is allowed only when the concept calls for a character",
  "reaction-face":
    "emotion-forward face or mask close-up: one expression fills the frame, rendered as sketch, paint, plastic, or graphic art as fits the joke",
  "graphic-emblem":
    "bold graphic emblem: screenprint/vector/poster language, sharp silhouette, limited palette, logo-like clarity without text",
  "object-icon":
    "single tangible object or symbolic prop: material detail, strong lighting, no face unless the tweet specifically needs one",
  "studio-photo":
    "photoreal studio avatar: macro/product-photo lighting, clean backdrop, crisp material texture, realistic shadows",
  "surreal-icon":
    "surreal conceptual icon: one impossible object or creature that visualizes the tweet's punchline, clean silhouette, dreamlike but not busy",
  "pixel-icon":
    "crisp pixel-art avatar: chunky pixels, readable silhouette, limited palette, modern game-item clarity",
  "3d-avatar":
    "3D collectible avatar: toy-like or clay/rendered object, simple lighting, tactile material, strong silhouette",
};
const DEFAULT_GENERATED_IMAGE_STYLE: ImageStyle = "graphic-emblem";

export type ImageOptions = {
  apiKey: string;
  model: string; // e.g. "gemini-2.5-flash-image"
};

export type PreparedImage = {
  buffer: Buffer;
  mimeType: string;
  source: "tweet" | "remix" | "generated";
};

export type ImageValidation =
  | { ok: true; mimeType: string; width: number; height: number }
  | { ok: false; reason: string };

/**
 * Decide-and-fetch the image bytes for the launch.
 * Honors imageStrategy from the metadata generator. On reuse/remix failure,
 * falls back to a generated image.
 */
export async function prepareImage(
  tweet: Tweet,
  meta: Metadata,
  options: ImageOptions,
): Promise<PreparedImage> {
  const log = getLogger({ tweet_id: tweet.id, pipeline_stage: "image" });
  const primaryImage = getPrimaryLaunchImage(tweet);
  const primaryImageSource = getPrimaryLaunchImageSource(tweet);

  if (meta.imageStrategy === "reuse" && primaryImage) {
    try {
      const buf = await downloadCappedImage(primaryImage.url);
      log.info(
        { bytes: buf.buffer.length, source: "tweet", image_source: primaryImageSource },
        "reused tweet image",
      );
      return { buffer: buf.buffer, mimeType: buf.mimeType, source: "tweet" };
    } catch (err) {
      log.warn({ err: errMsg(err) }, "reuse failed, falling back to generate");
      return generateFromPrompt(meta, options, log);
    }
  }

  if (meta.imageStrategy === "remix" && primaryImage) {
    try {
      const original = await downloadCappedImage(primaryImage.url);
      const remixed = await callGeminiImage({
        apiKey: options.apiKey,
        model: options.model,
        prompt: `Edit this image according to: ${meta.remixInstructions ?? ""}. Keep the source subject recognizable and apply only the requested tweet-specific visual changes. Do not replace the subject with a generic character. Re-render as a custom memecoin token avatar; do not force a cartoon style unless the edit instructions call for one. ${FRAMING_RULES}`,
        imageInline: { data: original.buffer.toString("base64"), mimeType: original.mimeType },
      });
      log.info({ source: "remix", image_source: primaryImageSource }, "remixed tweet image");
      return { buffer: remixed.buffer, mimeType: remixed.mimeType, source: "remix" };
    } catch (err) {
      log.warn({ err: errMsg(err) }, "remix failed, falling back to generate");
      return generateFromPrompt(meta, options, log);
    }
  }

  return generateFromPrompt(meta, options, log);
}

export function validateLaunchImage(image: PreparedImage): ImageValidation {
  if (image.buffer.length === 0) return { ok: false, reason: "image buffer is empty" };
  if (image.buffer.length > MAX_DOWNLOAD_BYTES) {
    return {
      ok: false,
      reason: `image buffer ${image.buffer.length} bytes exceeds ${MAX_DOWNLOAD_BYTES} byte cap`,
    };
  }

  const mimeType = normalizeImageMimeType(image.mimeType);
  if (!mimeType) return { ok: false, reason: `unsupported image MIME type: ${image.mimeType}` };

  const dimensions = readImageDimensions(image.buffer, mimeType);
  if (!dimensions) return { ok: false, reason: `could not read ${mimeType} image dimensions` };

  const ratio = dimensions.width / dimensions.height;
  if (ratio < 0.95 || ratio > 1.05) {
    return {
      ok: false,
      reason: `image must be square-ish for token icon use; got ${dimensions.width}x${dimensions.height}`,
    };
  }

  return { ok: true, mimeType, width: dimensions.width, height: dimensions.height };
}

async function generateFromPrompt(
  meta: Metadata,
  options: ImageOptions,
  log: ReturnType<typeof getLogger>,
): Promise<PreparedImage> {
  const generationPrompt = buildGeneratedImagePrompt(meta);
  let result: { buffer: Buffer; mimeType: string };
  try {
    result = await callGeminiImage({
      apiKey: options.apiKey,
      model: options.model,
      prompt: generationPrompt,
    });
  } catch (err) {
    if (!isGeminiNoInlineDataError(err)) throw err;
    const fallbackPrompt = buildSafeFallbackPrompt(meta);
    log.warn({ err: errMsg(err) }, "Gemini refused image output, retrying safe fallback prompt");
    result = await callGeminiImage({
      apiKey: options.apiKey,
      model: options.model,
      prompt: fallbackPrompt,
    });
  }
  log.info({ bytes: result.buffer.length, source: "generated" }, "generated image");
  return { buffer: result.buffer, mimeType: result.mimeType, source: "generated" };
}

function buildGeneratedImagePrompt(meta: Metadata): string {
  const prompt =
    meta.imagePrompt ??
    `Invent one distinctive visual metaphor for "${meta.name}" (${meta.symbol}) as a token avatar`;
  const style = meta.imageStyle ?? DEFAULT_GENERATED_IMAGE_STYLE;
  return `Create a custom token avatar for this launch. Token: "${meta.name}" ($${meta.symbol}). Visual concept: ${prompt}. Rendering style: ${IMAGE_STYLE_PROMPTS[style]}. Use details from the tweet rather than a reusable mascot template. Avoid generic crypto imagery and default cartoon faces unless the concept explicitly calls for them. ${CRYPTO_NATIVE_IMAGE_RULES} ${FRAMING_RULES}`;
}

function buildSafeFallbackPrompt(meta: Metadata): string {
  return `Create a ${SAFE_FALLBACK_IMAGE_STYLE} for a token named "${meta.name}" with ticker ${meta.symbol}. ${CRYPTO_NATIVE_IMAGE_RULES} ${FRAMING_RULES}`;
}

function normalizeImageMimeType(mimeType: string): string | null {
  const base = mimeType.split(";", 1)[0]?.trim().toLowerCase();
  if (base === "image/jpg") return "image/jpeg";
  if (
    base === "image/png" ||
    base === "image/jpeg" ||
    base === "image/gif" ||
    base === "image/webp"
  ) {
    return base;
  }
  return null;
}

function readImageDimensions(
  buffer: Buffer,
  mimeType: string,
): { width: number; height: number } | null {
  if (mimeType === "image/png") return readPngDimensions(buffer);
  if (mimeType === "image/jpeg") return readJpegDimensions(buffer);
  if (mimeType === "image/gif") return readGifDimensions(buffer);
  if (mimeType === "image/webp") return readWebpDimensions(buffer);
  return null;
}

function readPngDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 24) return null;
  if (
    !buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return null;
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function readGifDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 10) return null;
  const signature = buffer.toString("ascii", 0, 6);
  if (signature !== "GIF87a" && signature !== "GIF89a") return null;
  return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
}

function readWebpDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 30) return null;
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") {
    return null;
  }
  const chunk = buffer.toString("ascii", 12, 16);
  if (chunk === "VP8X" && buffer.length >= 30) {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3),
    };
  }
  if (chunk === "VP8 " && buffer.length >= 30) {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunk === "VP8L" && buffer.length >= 25) {
    const b0 = buffer[21];
    const b1 = buffer[22];
    const b2 = buffer[23];
    const b3 = buffer[24];
    if (b0 === undefined || b1 === undefined || b2 === undefined || b3 === undefined) return null;
    return {
      width: 1 + (((b1 & 0x3f) << 8) | b0),
      height: 1 + ((b3 << 6) | (b2 >> 2) | ((b1 & 0xc0) << 6)),
    };
  }
  return null;
}

function readJpegDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset];
    if (marker === undefined) return null;
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) return null;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) return null;
    if (isJpegStartOfFrame(marker)) {
      if (length < 7) return null;
      return {
        height: buffer.readUInt16BE(offset + 3),
        width: buffer.readUInt16BE(offset + 5),
      };
    }
    offset += length;
  }
  return null;
}

function isJpegStartOfFrame(marker: number): boolean {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  );
}

type GeminiImageRequest = {
  apiKey: string;
  model: string;
  prompt: string;
  imageInline?: { data: string; mimeType: string };
};

type GeminiInlineDataPart = { inlineData: { mimeType: string; data: string } };
type GeminiTextPart = { text: string };
type GeminiPart = GeminiInlineDataPart | GeminiTextPart;
type GeminiResponse = {
  candidates?: Array<{
    finishReason?: string;
    finishMessage?: string;
    content?: { parts?: GeminiPart[] };
  }>;
};

class GeminiNoInlineDataError extends Error {
  constructor(response: GeminiResponse) {
    super(formatGeminiNoInlineDataError(response));
    this.name = "GeminiNoInlineDataError";
  }
}

function isGeminiNoInlineDataError(err: unknown): err is GeminiNoInlineDataError {
  return err instanceof GeminiNoInlineDataError;
}

/**
 * Direct call to Gemini's generateContent endpoint for image output.
 * The AI SDK does not expose this image path, so the bot calls REST directly:
 *   POST https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent
 *
 * The API key stays in a header, not the URL.
 */
async function callGeminiImage(
  req: GeminiImageRequest,
): Promise<{ buffer: Buffer; mimeType: string }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(req.model)}:generateContent`;

  const parts: GeminiPart[] = [{ text: req.prompt }];
  if (req.imageInline) {
    parts.unshift({ inlineData: req.imageInline });
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": req.apiKey,
    },
    body: JSON.stringify({
      contents: [{ parts }],
    }),
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "<no body>");
    throw new Error(formatGeminiHttpError(response.status, text, req.model));
  }

  const json = (await response.json()) as GeminiResponse;
  const allParts = json.candidates?.[0]?.content?.parts ?? [];
  const inlinePart = allParts.find(
    (p): p is GeminiInlineDataPart => "inlineData" in p && p.inlineData?.data !== undefined,
  );
  if (!inlinePart) {
    throw new GeminiNoInlineDataError(json);
  }
  const buffer = Buffer.from(inlinePart.inlineData.data, "base64");
  return { buffer, mimeType: inlinePart.inlineData.mimeType ?? "image/png" };
}

function formatGeminiNoInlineDataError(response: GeminiResponse): string {
  const candidate = response.candidates?.[0];
  const reason = candidate?.finishReason;
  const message = candidate?.finishMessage?.replace(/\s+/g, " ").trim();
  if (reason || message) {
    const detail = [reason, message].filter(Boolean).join(": ");
    return `Gemini image response had no inlineData (${detail})`;
  }
  return `Gemini image response had no inlineData: ${JSON.stringify(response).slice(0, 240)}`;
}

/**
 * Build a compact, human-readable error from a Gemini API non-OK response.
 * The raw 429 body is a multi-kilobyte JSON dump full of quota metric metadata
 * that's noise in a dashboard reason cell. This pulls out just the bits a
 * human reader needs: status, summary, and the retry hint when present.
 *
 * Exported for unit testing.
 */
export function formatGeminiHttpError(status: number, body: string, model: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    const trimmed = body.trim().replace(/\s+/g, " ").slice(0, 160);
    return `Gemini image API ${status}${trimmed ? `: ${trimmed}` : ""}`;
  }

  const errField =
    parsed && typeof parsed === "object" && "error" in parsed
      ? (parsed as { error: unknown }).error
      : null;
  const obj =
    errField && typeof errField === "object" ? (errField as Record<string, unknown>) : null;
  const apiStatus = typeof obj?.status === "string" ? obj.status : null;
  const message = typeof obj?.message === "string" ? obj.message : null;

  if (status === 429 || apiStatus === "RESOURCE_EXHAUSTED") {
    const retrySec = extractGeminiRetrySeconds(obj, message);
    const retryStr = retrySec > 0 ? ` (retry in ${retrySec}s)` : "";
    return `Gemini ${model} quota exceeded${retryStr}`;
  }

  const firstLine = (message ?? "").split(/\r?\n/, 1)[0]?.trim() ?? "";
  const summary = firstLine.length > 160 ? `${firstLine.slice(0, 160)}...` : firstLine;
  const label = apiStatus ?? `HTTP ${status}`;
  return `Gemini image API ${label}${summary ? `: ${summary}` : ""}`;
}

/**
 * Extract the retry delay from a Gemini 429 / RESOURCE_EXHAUSTED response.
 * Gemini returns the hint in two shapes:
 *   - the `details[].retryInfo.retryDelay` field (canonical, like "23s")
 *   - inline in the human message ("Please retry in 23s")
 * Both are best-effort - we return 0 if neither is present.
 */
function extractGeminiRetrySeconds(
  errorObj: Record<string, unknown> | null,
  message: string | null,
): number {
  const details = errorObj && Array.isArray(errorObj.details) ? errorObj.details : [];
  for (const entry of details) {
    if (!entry || typeof entry !== "object") continue;
    const retryInfo = (entry as Record<string, unknown>).retryInfo;
    const retryDelay =
      retryInfo && typeof retryInfo === "object"
        ? (retryInfo as Record<string, unknown>).retryDelay
        : undefined;
    if (typeof retryDelay === "string") {
      const match = /([\d.]+)s/i.exec(retryDelay);
      if (match?.[1]) {
        const sec = Math.round(Number.parseFloat(match[1]));
        if (Number.isFinite(sec) && sec > 0) return sec;
      }
    }
  }
  if (message) {
    const inline = /retry in ([\d.]+)s/i.exec(message);
    if (inline?.[1]) {
      const sec = Math.round(Number.parseFloat(inline[1]));
      if (Number.isFinite(sec) && sec > 0) return sec;
    }
  }
  return 0;
}

type CappedDownload = { buffer: Buffer; mimeType: string };

/**
 * Defensive image download:
 * 1. Allowlist scheme and host (HTTPS plus X CDN only).
 * 2. Resolve hostname and reject loopback / private / link-local IPs
 * 3. Reject if Content-Length is missing or > 5MB
 * 4. Reject if Content-Type is not image/*
 * 5. Stream body and abort if running byte count exceeds 5MB.
 * 6. Reject redirects.
 * 7. Hard request timeout (`AbortSignal.timeout`) covering both the
 *    headers and the body read.
 */
export async function downloadCappedImage(url: string): Promise<CappedDownload> {
  await assertSafeImageUrl(url);

  const timeoutSignal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const sizeController = new AbortController();
  const signal = AbortSignal.any([timeoutSignal, sizeController.signal]);

  const response = await fetch(url, { signal, redirect: "error" });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching ${url}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.startsWith("image/")) {
    sizeController.abort();
    throw new Error(`refusing non-image content-type: ${contentType}`);
  }

  const lengthHeader = response.headers.get("content-length");
  if (!lengthHeader) {
    sizeController.abort();
    throw new Error("refusing download with missing Content-Length");
  }
  const declared = Number.parseInt(lengthHeader, 10);
  if (!Number.isFinite(declared) || declared > MAX_DOWNLOAD_BYTES) {
    sizeController.abort();
    throw new Error(`refusing download: declared ${declared} bytes > ${MAX_DOWNLOAD_BYTES} cap`);
  }

  if (!response.body) {
    throw new Error("response body is null");
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.length;
      if (total > MAX_DOWNLOAD_BYTES) {
        sizeController.abort();
        throw new Error(`download exceeded ${MAX_DOWNLOAD_BYTES} byte cap mid-stream`);
      }
      chunks.push(value);
    }
  }
  return { buffer: Buffer.concat(chunks), mimeType: contentType };
}

/**
 * Validate the URL's scheme, host, and resolved address before fetching.
 */
async function assertSafeImageUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`malformed image URL: ${url}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`refusing non-https image url: ${parsed.protocol}`);
  }
  if (!ALLOWED_IMAGE_HOSTS.has(parsed.hostname)) {
    throw new Error(`refusing image host: ${parsed.hostname}`);
  }
  // Check the resolved IP too; host allowlists do not protect against DNS surprises.
  let address: string;
  try {
    const result = await lookup(parsed.hostname);
    address = result.address;
  } catch (err) {
    throw new Error(`DNS lookup failed for ${parsed.hostname}: ${errMsg(err)}`);
  }
  if (isPrivateOrLocalAddress(address)) {
    throw new Error(
      `refusing image host ${parsed.hostname} (resolved to private/local ${address})`,
    );
  }
}

function isPrivateOrLocalAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const parts = address.split(".").map((p) => Number.parseInt(p, 10));
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return true; // unparseable means unsafe
    }
    const [a, b] = parts as [number, number, number, number];
    if (a === 10) return true;
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local + AWS metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 0) return true;
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    if (lower === "::" || lower === "::1") return true; // unspecified / loopback
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique-local
    if (lower.startsWith("fe80")) return true; // link-local
    if (lower.startsWith("::ffff:")) {
      // IPv4-mapped; apply the v4 rules to the embedded address.
      const v4 = lower.slice("::ffff:".length);
      return isPrivateOrLocalAddress(v4);
    }
    return false;
  }
  return true; // unrecognized format means unsafe
}
