import { describe, expect, it } from "vitest";
import { type Metadata, validateMetadata } from "../src/brain/metadata.js";
import type { Tweet } from "../src/sources/tweet-source.js";

const baseTweet = (withImage = false): Tweet => ({
  id: "t1",
  authorHandle: "elonmusk",
  authorId: "1",
  text: "hi",
  createdAt: new Date(),
  images: withImage ? [{ url: "https://x.com/img.jpg", mimeType: "image/jpeg" }] : [],
  isReply: false,
  isRetweet: false,
  isQuoteTweet: false,
});

const baseMeta: Metadata = {
  name: "Elon Doge",
  symbol: "EDOGE",
  imageStrategy: "generate",
  imagePrompt: "doge in space",
};

describe("validateMetadata", () => {
  it("passes a clean metadata", () => {
    expect(validateMetadata(baseMeta, baseTweet())).toBeNull();
  });

  it("rejects name longer than 32 bytes after NFKC normalization", () => {
    const meta = { ...baseMeta, name: "a".repeat(33) };
    const failure = validateMetadata(meta, baseTweet());
    expect(failure?.field).toBe("name");
    expect(failure?.reason).toMatch(/32 bytes/);
  });

  it("rejects symbol longer than 10 bytes", () => {
    const meta = { ...baseMeta, symbol: "ABCDEFGHIJK" };
    const failure = validateMetadata(meta, baseTweet());
    expect(failure?.field).toBe("symbol");
    expect(failure?.reason).toMatch(/10 bytes/);
  });

  it("rejects symbol with spaces or non-[A-Z0-9]", () => {
    const meta = { ...baseMeta, symbol: "DO GE" };
    const failure = validateMetadata(meta, baseTweet());
    expect(failure?.field).toBe("symbol");
    expect(failure?.reason).toMatch(/A-Z0-9/);
  });

  it("rejects reserved symbols", () => {
    for (const reserved of ["SOL", "USDC", "BLNK"]) {
      const meta = { ...baseMeta, symbol: reserved };
      const failure = validateMetadata(meta, baseTweet());
      expect(failure?.field).toBe("symbol");
      expect(failure?.reason).toMatch(/reserved/);
    }
  });

  it("rejects generate without imagePrompt", () => {
    const meta: Metadata = { ...baseMeta, imageStrategy: "generate" };
    (meta as { imagePrompt?: string }).imagePrompt = undefined;
    const failure = validateMetadata(meta, baseTweet());
    expect(failure?.field).toBe("imageStrategy_consistency");
  });

  it("rejects remix without remixInstructions", () => {
    const meta: Metadata = { ...baseMeta, imageStrategy: "remix" };
    const failure = validateMetadata(meta, baseTweet(true));
    expect(failure?.field).toBe("imageStrategy_consistency");
    expect(failure?.reason).toMatch(/remixInstructions/);
  });

  it("rejects remix when tweet has no image to remix", () => {
    const meta: Metadata = {
      ...baseMeta,
      imageStrategy: "remix",
      remixInstructions: "make it pop",
    };
    const failure = validateMetadata(meta, baseTweet(false));
    expect(failure?.field).toBe("imageStrategy_consistency");
    expect(failure?.reason).toMatch(/no image to remix/);
  });

  it("rejects reuse when tweet has no image to reuse", () => {
    const meta: Metadata = { ...baseMeta, imageStrategy: "reuse" };
    const failure = validateMetadata(meta, baseTweet(false));
    expect(failure?.field).toBe("imageStrategy_consistency");
    expect(failure?.reason).toMatch(/no image to reuse/);
  });

  it("accepts reuse when tweet has an image", () => {
    const meta: Metadata = { ...baseMeta, imageStrategy: "reuse" };
    (meta as { imagePrompt?: string }).imagePrompt = undefined;
    expect(validateMetadata(meta, baseTweet(true))).toBeNull();
  });

  it("accepts a multi-byte name within 32 bytes", () => {
    // 8 emoji = 32 bytes (each is 4 bytes in UTF-8)
    const meta = { ...baseMeta, name: "🚀".repeat(8) };
    expect(validateMetadata(meta, baseTweet())).toBeNull();
  });

  it("rejects a multi-byte name exceeding 32 bytes", () => {
    const meta = { ...baseMeta, name: "🚀".repeat(9) }; // 36 bytes
    const failure = validateMetadata(meta, baseTweet());
    expect(failure?.field).toBe("name");
  });
});
