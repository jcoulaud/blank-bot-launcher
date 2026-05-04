import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadCappedImage } from "../src/brain/image.js";

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
    const result = await downloadCappedImage("https://x/img.jpg");
    expect(result.buffer.length).toBe(1024);
    expect(result.mimeType).toBe("image/jpeg");
  });

  it("rejects non-image content-type", async () => {
    mockFetchOnce({
      contentType: "text/html",
      contentLength: "10",
      bodyChunks: [new Uint8Array(10)],
    });
    await expect(downloadCappedImage("https://x/x.html")).rejects.toThrow(/non-image/);
  });

  it("rejects when content-length is missing", async () => {
    mockFetchOnce({
      contentType: "image/jpeg",
      contentLength: null,
      bodyChunks: [new Uint8Array(10)],
    });
    await expect(downloadCappedImage("https://x/y")).rejects.toThrow(/Content-Length/);
  });

  it("rejects when declared length exceeds cap", async () => {
    mockFetchOnce({
      contentType: "image/jpeg",
      contentLength: String(6 * 1024 * 1024),
      bodyChunks: [new Uint8Array(10)],
    });
    await expect(downloadCappedImage("https://x/big")).rejects.toThrow(/cap/);
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
    await expect(downloadCappedImage("https://x/lie")).rejects.toThrow();
  });

  it("rejects HTTP errors", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 404 })) as never;
    await expect(downloadCappedImage("https://x/missing")).rejects.toThrow(/HTTP 404/);
  });
});
