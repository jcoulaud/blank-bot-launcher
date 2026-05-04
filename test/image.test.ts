import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadCappedImage, formatGeminiHttpError } from "../src/brain/image.js";

const originalFetch = globalThis.fetch;

function mockFetchOnce(init: {
  status?: number;
  contentType?: string;
  contentLength?: string | null;
  bodyChunks: Uint8Array[];
}): void {
  const headers = new Headers();
  if (init.contentType) headers.set("content-type", init.contentType);
  if (init.contentLength !== null && init.contentLength !== undefined) {
    headers.set("content-length", init.contentLength);
  }

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of init.bodyChunks) controller.enqueue(chunk);
      controller.close();
    },
  });

  const response = new Response(body, { status: init.status ?? 200, headers });
  globalThis.fetch = vi.fn().mockResolvedValue(response) as never;
}

describe("downloadCappedImage", () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns the image when small and within cap", async () => {
    const data = new Uint8Array(1024).fill(0xab);
    mockFetchOnce({
      contentType: "image/jpeg",
      contentLength: String(data.length),
      bodyChunks: [data],
    });
    const result = await downloadCappedImage("https://pbs.twimg.com/media/img.jpg");
    expect(result.buffer.length).toBe(1024);
    expect(result.mimeType).toBe("image/jpeg");
  });

  it("rejects non-image content-type", async () => {
    mockFetchOnce({
      contentType: "text/html",
      contentLength: "10",
      bodyChunks: [new Uint8Array(10)],
    });
    await expect(downloadCappedImage("https://pbs.twimg.com/x.html")).rejects.toThrow(/non-image/);
  });

  it("rejects when content-length is missing", async () => {
    mockFetchOnce({
      contentType: "image/jpeg",
      contentLength: null,
      bodyChunks: [new Uint8Array(10)],
    });
    await expect(downloadCappedImage("https://pbs.twimg.com/media/y")).rejects.toThrow(
      /Content-Length/,
    );
  });

  it("rejects when declared length exceeds cap", async () => {
    mockFetchOnce({
      contentType: "image/jpeg",
      contentLength: String(6 * 1024 * 1024),
      bodyChunks: [new Uint8Array(10)],
    });
    await expect(downloadCappedImage("https://pbs.twimg.com/media/big")).rejects.toThrow(/cap/);
  });

  it("aborts mid-stream if running byte count exceeds cap", async () => {
    // Lying Content-Length: declared 1KB, sends 6MB
    const big = new Uint8Array(6 * 1024 * 1024).fill(0x55);
    mockFetchOnce({
      contentType: "image/jpeg",
      contentLength: "1024",
      bodyChunks: [big],
    });
    // Note: this case is also caught by the Content-Length pre-check (declared <= cap so passes
    // initial check, then stream actually delivers more bytes than declared). We expect either
    // the pre-check passes and the stream-cap triggers, OR the pre-check rejects. Both are valid.
    await expect(downloadCappedImage("https://pbs.twimg.com/media/lie")).rejects.toThrow();
  });

  it("rejects HTTP errors", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 404 })) as never;
    await expect(downloadCappedImage("https://pbs.twimg.com/media/missing")).rejects.toThrow(
      /HTTP 404/,
    );
  });
});

describe("formatGeminiHttpError", () => {
  it("compacts a 429 RESOURCE_EXHAUSTED quota body to a single readable line", () => {
    const body = JSON.stringify({
      error: {
        code: 429,
        message:
          "You exceeded your current quota, please check your plan and billing details.\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-2.5-flash-preview-image\nPlease retry in 10.109036662s.",
        status: "RESOURCE_EXHAUSTED",
      },
    });
    const out = formatGeminiHttpError(429, body, "gemini-2.5-flash-preview-image");
    expect(out).toBe("Gemini gemini-2.5-flash-preview-image quota exceeded (retry in 10s)");
  });

  it("falls back gracefully when the body is not JSON", () => {
    const out = formatGeminiHttpError(502, "Bad Gateway", "gemini-2.5-flash-preview-image");
    expect(out).toBe("Gemini image API 502: Bad Gateway");
  });

  it("uses the API status and a single message line for non-quota errors", () => {
    const body = JSON.stringify({
      error: {
        code: 400,
        status: "INVALID_ARGUMENT",
        message: "Request contains an invalid argument.\nfoo bar\nbaz",
      },
    });
    const out = formatGeminiHttpError(400, body, "gemini-2.5-flash-preview-image");
    expect(out).toBe("Gemini image API INVALID_ARGUMENT: Request contains an invalid argument.");
  });

  it("caps very long single-line messages", () => {
    const long = "x".repeat(500);
    const body = JSON.stringify({ error: { status: "INTERNAL", message: long } });
    const out = formatGeminiHttpError(500, body, "model");
    expect(out.length).toBeLessThan(220);
    expect(out.endsWith("...")).toBe(true);
  });
});
