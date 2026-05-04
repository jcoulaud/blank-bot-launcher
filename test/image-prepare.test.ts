import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Metadata } from "../src/brain/metadata.js";
import type { Tweet } from "../src/sources/tweet-source.js";

const originalFetch = globalThis.fetch;

const tweetWithImage: Tweet = {
  id: "t1",
  authorHandle: "elonmusk",
  authorId: "1",
  text: "doge",
  createdAt: new Date(),
  images: [{ url: "https://pbs.twimg.com/media/img.jpg" }],
  isReply: false,
  isRetweet: false,
  isQuoteTweet: false,
};

const tweetNoImage: Tweet = { ...tweetWithImage, images: [] };

// Standard public IPv4 so SSRF guard accepts the host.
function mockDnsPublic() {
  vi.doMock("node:dns/promises", () => ({
    lookup: vi.fn().mockResolvedValue({ address: "199.59.148.246", family: 4 }),
  }));
}

function imageDownloadResponse(): Response {
  const data = new Uint8Array(64).fill(0xab);
  return new Response(data, {
    status: 200,
    headers: { "content-type": "image/jpeg", "content-length": String(data.length) },
  });
}

function geminiImageResponse(): Response {
  return new Response(
    JSON.stringify({
      candidates: [
        {
          content: {
            parts: [
              {
                inlineData: {
                  mimeType: "image/png",
                  data: Buffer.from("fake-png").toString("base64"),
                },
              },
            ],
          },
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function geminiNoInlineDataResponse(): Response {
  return new Response(
    JSON.stringify({
      candidates: [
        {
          finishReason: "IMAGE_OTHER",
          index: 0,
          finishMessage:
            "Unable to show the generated image. The model could not generate the image based on the prompt provided.",
        },
      ],
      usageMetadata: { promptTokenCount: 59, candidatesTokenCount: 11, totalTokenCount: 70 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("prepareImage dispatch", () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    globalThis.fetch = originalFetch;
  });

  it("reuse strategy with tweet image returns the downloaded bytes", async () => {
    mockDnsPublic();
    globalThis.fetch = vi.fn().mockResolvedValue(imageDownloadResponse()) as never;
    const { prepareImage } = await import("../src/brain/image.js");
    const meta: Metadata = { name: "doge", symbol: "DOGE", imageStrategy: "reuse" };
    const result = await prepareImage(tweetWithImage, meta, { apiKey: "k", model: "m" });
    expect(result.source).toBe("tweet");
    expect(result.buffer.length).toBe(64);
  });

  it("reuse strategy falls back to generate on download failure", async () => {
    mockDnsPublic();
    globalThis.fetch = vi
      .fn()
      // First call: image download returns 404.
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      // Second call: Gemini generate
      .mockResolvedValueOnce(geminiImageResponse()) as never;
    const { prepareImage } = await import("../src/brain/image.js");
    const meta: Metadata = {
      name: "doge",
      symbol: "DOGE",
      imageStrategy: "reuse",
      imagePrompt: "fallback",
    };
    const result = await prepareImage(tweetWithImage, meta, { apiKey: "k", model: "m" });
    expect(result.source).toBe("generated");
    expect(result.mimeType).toBe("image/png");
  });

  it("remix strategy downloads and calls Gemini with imageInline", async () => {
    mockDnsPublic();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(imageDownloadResponse())
      .mockResolvedValueOnce(geminiImageResponse());
    globalThis.fetch = fetchMock as never;
    const { prepareImage } = await import("../src/brain/image.js");
    const meta: Metadata = {
      name: "doge",
      symbol: "DOGE",
      imageStrategy: "remix",
      remixInstructions: "make it pop",
    };
    const result = await prepareImage(tweetWithImage, meta, { apiKey: "k", model: "m" });
    expect(result.source).toBe("remix");
    // Second call is Gemini; verify imageInline was sent
    const geminiCall = fetchMock.mock.calls[1];
    const body = JSON.parse(((geminiCall?.[1] as RequestInit).body as string) ?? "{}");
    const parts = body.contents?.[0]?.parts ?? [];
    expect(parts.some((p: { inlineData?: unknown }) => p.inlineData)).toBe(true);
  });

  it("remix strategy falls back to generate on download failure", async () => {
    mockDnsPublic();
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(geminiImageResponse()) as never;
    const { prepareImage } = await import("../src/brain/image.js");
    const meta: Metadata = {
      name: "doge",
      symbol: "DOGE",
      imageStrategy: "remix",
      remixInstructions: "x",
    };
    const result = await prepareImage(tweetWithImage, meta, { apiKey: "k", model: "m" });
    expect(result.source).toBe("generated");
  });

  it("generate strategy with imagePrompt calls Gemini without imageInline", async () => {
    mockDnsPublic();
    const fetchMock = vi.fn().mockResolvedValueOnce(geminiImageResponse());
    globalThis.fetch = fetchMock as never;
    const { prepareImage } = await import("../src/brain/image.js");
    const meta: Metadata = {
      name: "doge",
      symbol: "DOGE",
      imageStrategy: "generate",
      imageStyle: "clean-vector-mascot",
      imagePrompt: "doge in space",
    };
    const result = await prepareImage(tweetNoImage, meta, { apiKey: "k", model: "m" });
    expect(result.source).toBe("generated");
    const geminiCall = fetchMock.mock.calls[0];
    const body = JSON.parse(((geminiCall?.[1] as RequestInit).body as string) ?? "{}");
    const parts = body.contents?.[0]?.parts ?? [];
    expect(parts.some((p: { inlineData?: unknown }) => p.inlineData)).toBe(false);
    const text = parts.find((p: { text?: string }) => p.text)?.text ?? "";
    expect(text).toContain("doge in space");
    expect(text).toContain("clean vector mascot");
    expect(text).toContain("No on-image text overlay");
  });

  it("generate strategy uses default prompt when imagePrompt missing", async () => {
    mockDnsPublic();
    const fetchMock = vi.fn().mockResolvedValueOnce(geminiImageResponse());
    globalThis.fetch = fetchMock as never;
    const { prepareImage } = await import("../src/brain/image.js");
    const meta: Metadata = { name: "doge", symbol: "DOGE", imageStrategy: "generate" };
    await prepareImage(tweetNoImage, meta, { apiKey: "k", model: "m" });
    const body = JSON.parse(((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string) ?? "{}");
    const text = body.contents?.[0]?.parts?.[0]?.text ?? "";
    expect(text).toContain("doge");
  });

  it("generate strategy retries with a safe fallback when Gemini returns no image output", async () => {
    mockDnsPublic();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(geminiNoInlineDataResponse())
      .mockResolvedValueOnce(geminiImageResponse());
    globalThis.fetch = fetchMock as never;
    const { prepareImage } = await import("../src/brain/image.js");
    const meta: Metadata = {
      name: "Vitalik quote",
      symbol: "VITALIK",
      imageStrategy: "generate",
      imagePrompt: "Vitalik Buterin as a meme king in a chaotic crypto scene",
    };
    const result = await prepareImage(tweetNoImage, meta, { apiKey: "k", model: "m" });
    expect(result.source).toBe("generated");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const retryBody = JSON.parse(
      ((fetchMock.mock.calls[1]?.[1] as RequestInit).body as string) ?? "{}",
    );
    const retryText = retryBody.contents?.[0]?.parts?.[0]?.text ?? "";
    expect(retryText).toContain("safe abstract crypto meme mascot");
    expect(retryText).toContain("no public figures");
    expect(retryText).toContain("VITALIK");
  });

  it("reports no-image Gemini responses as a compact error if the safe fallback also fails", async () => {
    mockDnsPublic();
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(geminiNoInlineDataResponse())
      .mockResolvedValueOnce(geminiNoInlineDataResponse()) as never;
    const { prepareImage } = await import("../src/brain/image.js");
    const meta: Metadata = {
      name: "Vitalik quote",
      symbol: "VITALIK",
      imageStrategy: "generate",
      imagePrompt: "Vitalik Buterin as a meme king in a chaotic crypto scene",
    };
    await expect(prepareImage(tweetNoImage, meta, { apiKey: "k", model: "m" })).rejects.toThrow(
      /Gemini image response had no inlineData \(IMAGE_OTHER: Unable to show the generated image/,
    );
  });
});
