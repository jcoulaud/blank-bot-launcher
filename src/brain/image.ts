import { getLogger } from "../logger.js";
import type { Tweet } from "../sources/tweet-source.js";
import type { Metadata } from "./metadata.js";

const MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024; // 5 MB hard cap (per D9)

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
 * Honors imageStrategy from the metadata generator. On any reuse/remix
 * failure, falls back to "generate" (per D9 + design §5.5).
 */
export async function prepareImage(
  tweet: Tweet,
  meta: Metadata,
  options: ImageOptions,
): Promise<PreparedImage> {
  const log = getLogger({ tweet_id: tweet.id, pipeline_stage: "image" });

  if (meta.imageStrategy === "reuse" && tweet.images[0]) {
    try {
      const buf = await downloadCappedImage(tweet.images[0].url);
      log.info({ bytes: buf.buffer.length, source: "tweet" }, "reused tweet image");
      return { buffer: buf.buffer, mimeType: buf.mimeType, source: "tweet" };
    } catch (err) {
      log.warn({ err: errMessage(err) }, "reuse failed, falling back to generate");
      return generateFromPrompt(meta, options, log);
    }
  }

  if (meta.imageStrategy === "remix" && tweet.images[0]) {
    try {
      const original = await downloadCappedImage(tweet.images[0].url);
      const remixed = await callGeminiImage({
        apiKey: options.apiKey,
        model: options.model,
        prompt: `Edit this image according to: ${meta.remixInstructions ?? ""}. Keep the meme/character intact, refine style only.`,
        imageInline: { data: original.buffer.toString("base64"), mimeType: original.mimeType },
      });
      log.info({ source: "remix" }, "remixed tweet image");
      return { buffer: remixed.buffer, mimeType: remixed.mimeType, source: "remix" };
    } catch (err) {
      log.warn({ err: errMessage(err) }, "remix failed, falling back to generate");
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
    meta.imagePrompt ??
    `cartoon meme illustration of "${meta.name}", bold colors, simple shapes, no text overlay`;
  const result = await callGeminiImage({
    apiKey: options.apiKey,
    model: options.model,
    prompt,
  });
  log.info({ bytes: result.buffer.length, source: "generated" }, "generated image");
  return { buffer: result.buffer, mimeType: result.mimeType, source: "generated" };
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
    content?: { parts?: GeminiPart[] };
  }>;
};

/**
 * Direct call to Gemini's generateContent endpoint for image output.
 * Vercel AI SDK v1 doesn't yet expose image generation for the Gemini provider,
 * so we hit the REST API directly. Spec:
 *   POST https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent
 */
async function callGeminiImage(
  req: GeminiImageRequest,
): Promise<{ buffer: Buffer; mimeType: string }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(req.model)}:generateContent?key=${encodeURIComponent(req.apiKey)}`;

  const parts: GeminiPart[] = [{ text: req.prompt }];
  if (req.imageInline) {
    parts.unshift({ inlineData: req.imageInline });
  }

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts }],
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "<no body>");
    throw new Error(`Gemini image API failed: ${response.status} ${text}`);
  }

  const json = (await response.json()) as GeminiResponse;
  const allParts = json.candidates?.[0]?.content?.parts ?? [];
  const inlinePart = allParts.find(
    (p): p is GeminiInlineDataPart => "inlineData" in p && p.inlineData?.data !== undefined,
  );
  if (!inlinePart) {
    throw new Error(
      `Gemini image response had no inlineData: ${JSON.stringify(json).slice(0, 500)}`,
    );
  }
  const buffer = Buffer.from(inlinePart.inlineData.data, "base64");
  return { buffer, mimeType: inlinePart.inlineData.mimeType ?? "image/png" };
}

type CappedDownload = { buffer: Buffer; mimeType: string };

/**
 * Defensive image download (per D9):
 * 1. Reject if Content-Length is missing or > 5MB
 * 2. Reject if Content-Type is not image/*
 * 3. Stream body and abort if running byte count exceeds 5MB (defends against
 *    lying Content-Length).
 */
export async function downloadCappedImage(url: string): Promise<CappedDownload> {
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching ${url}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.startsWith("image/")) {
    controller.abort();
    throw new Error(`refusing non-image content-type: ${contentType}`);
  }

  const lengthHeader = response.headers.get("content-length");
  if (!lengthHeader) {
    controller.abort();
    throw new Error("refusing download with missing Content-Length");
  }
  const declared = Number.parseInt(lengthHeader, 10);
  if (!Number.isFinite(declared) || declared > MAX_DOWNLOAD_BYTES) {
    controller.abort();
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
        controller.abort();
        throw new Error(`download exceeded ${MAX_DOWNLOAD_BYTES} byte cap mid-stream`);
      }
      chunks.push(value);
    }
  }
  return { buffer: Buffer.concat(chunks), mimeType: contentType };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
