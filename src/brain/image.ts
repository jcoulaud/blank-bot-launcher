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
  "safe abstract crypto mascot icon, single chunky cartoon character centered on one flat saturated background color, thick black outline, BONK/WIF/POPCAT-style token icon, no public figures, no real people, no copyrighted characters, no violence, no political symbols";
const FRAMING_RULES =
  "OUTPUT FORMAT: a memecoin token icon, in the visual family of BONK, WIF, POPCAT, PEPE, DOGE — designed to be recognized at 32x32 pixel favicon size on a token list. Square 1:1. Composition: ONE subject (a single character face/head or single chunky object), centered, occupying 70-90% of the canvas, with a strong recognizable silhouette and thick bold outlines. Background: ONE flat saturated solid color (or a very simple two-tone radial), continuous from pixel (0,0) to (canvas_width, canvas_height) with no edge treatment of any kind. The background color and the subject together fill 100% of the canvas. The image MUST NOT contain ANY of: panels, comic gutters, frame lines, outer borders, mattes, vignettes, letterbox bars, padding, margins, caption strips, banner ribbons, title cards, name plates, speech bubbles, watermarks, signatures, logos, words, letters, numbers, or any kind of writing, lettering, or text whatsoever — anywhere in the image, in any language, including stylized graffiti or background text. If the model is tempted to add a caption, label, panel, or border, it must instead extend the flat background color into that space.";
const IMAGE_STYLE_PROMPTS: Record<ImageStyle, string> = {
  "classic-meme-poster":
    "bold meme-poster mascot icon: single character or object centered on one flat saturated background color, thick black outline, high contrast, BONK/PEPE-style token icon — NO panels, NO captions, NO text, NO border",
  "reaction-image":
    "single reaction-character close-up filling the frame, exaggerated facial expression, thick cartoon outlines, one flat saturated background color edge-to-edge — Wojak/Pepe/Apu/Chad portrait icon style — NO panels, NO speech bubbles, NO text, NO border",
  "clean-vector-mascot":
    "clean vector mascot icon, single chunky shape, strong silhouette, thick outline, one flat saturated background color edge-to-edge, app-icon framing — NO badges, NO ribbons, NO text, NO border",
};
const DEFAULT_GENERATED_IMAGE_STYLE: ImageStyle = "classic-meme-poster";

export type ImageOptions = {
  apiKey: string;
  model: string; // e.g. "gemini-2.5-flash-image"
};

export type PreparedImage = {
  buffer: Buffer;
  mimeType: string;
  source: "tweet" | "remix" | "generated";
};

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
        prompt: `Edit this image according to: ${meta.remixInstructions ?? ""}. Keep the source subject recognizable and apply only the requested joke-driven visual changes. Do not replace the subject with a generic character. Re-render as a memecoin token icon: single subject centered, one flat saturated background color edge-to-edge, thick outlines, no panels, no captions, no text of any kind. ${FRAMING_RULES}`,
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

async function generateFromPrompt(
  meta: Metadata,
  options: ImageOptions,
  log: ReturnType<typeof getLogger>,
): Promise<PreparedImage> {
  const prompt =
    meta.imagePrompt ?? `cartoon meme illustration of "${meta.name}", bold colors, simple shapes`;
  const style = meta.imageStyle ?? DEFAULT_GENERATED_IMAGE_STYLE;
  const generationPrompt = `${prompt}. Visual style: ${IMAGE_STYLE_PROMPTS[style]}. ${FRAMING_RULES}`;
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

function buildSafeFallbackPrompt(meta: Metadata): string {
  return `Create a ${SAFE_FALLBACK_IMAGE_STYLE} for a token named "${meta.name}" with ticker ${meta.symbol}. ${FRAMING_RULES}`;
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
