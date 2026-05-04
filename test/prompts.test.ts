import { describe, expect, it } from "vitest";
import {
  buildClassifierPrompt,
  buildMetadataPrompt,
  isReservedSymbol,
  PROMPT_VERSION,
} from "../src/brain/prompts.js";
import type { Tweet } from "../src/sources/tweet-source.js";

const sampleTweet: Tweet = {
  id: "t1",
  authorHandle: "elonmusk",
  authorId: "1",
  text: "doge to the moon",
  createdAt: new Date(),
  images: [],
  isReply: false,
  isRetweet: false,
  isQuoteTweet: false,
};

describe("isReservedSymbol", () => {
  it("flags SOL, USDC, BLNK case-insensitively", () => {
    expect(isReservedSymbol("SOL")).toBe(true);
    expect(isReservedSymbol("usdc")).toBe(true);
    expect(isReservedSymbol("BLnK")).toBe(true);
  });

  it("does not flag normal symbols", () => {
    expect(isReservedSymbol("DOGE")).toBe(false);
    expect(isReservedSymbol("FNOW")).toBe(false);
  });
});

describe("buildClassifierPrompt", () => {
  it("includes the tweet text and author", () => {
    const prompt = buildClassifierPrompt(sampleTweet);
    expect(prompt).toContain("doge to the moon");
    expect(prompt).toContain("elonmusk");
    expect(prompt).toContain("0.85");
  });

  it("notes when an image is present", () => {
    const withImg = { ...sampleTweet, images: [{ url: "https://x", mimeType: "image/jpeg" }] };
    expect(buildClassifierPrompt(withImg)).toContain("Has image: yes");
  });
});

describe("buildMetadataPrompt", () => {
  it("includes reserved symbols list", () => {
    const prompt = buildMetadataPrompt({ tweet: sampleTweet });
    expect(prompt).toContain("SOL");
    expect(prompt).toContain("USDC");
    expect(prompt).toContain("BLNK");
  });

  it("includes the corrective hint when given", () => {
    const prompt = buildMetadataPrompt({
      tweet: sampleTweet,
      previousFailureHint: "symbol SOL is reserved",
    });
    expect(prompt).toContain("previous attempt failed");
    expect(prompt).toContain("symbol SOL is reserved");
  });

  it("omits the hint when none given", () => {
    const prompt = buildMetadataPrompt({ tweet: sampleTweet });
    expect(prompt).not.toContain("previous attempt failed");
  });
});

describe("PROMPT_VERSION", () => {
  it("is a positive integer", () => {
    expect(PROMPT_VERSION).toBeGreaterThan(0);
    expect(Number.isInteger(PROMPT_VERSION)).toBe(true);
  });
});
