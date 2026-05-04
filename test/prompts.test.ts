import { describe, expect, it } from "vitest";
import {
  buildClassifierPrompt,
  buildMetadataPrompt,
  isReservedSymbol,
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
const sampleClassification = {
  shouldLaunch: true,
  confidence: 0.95,
  reason: "sticky doge catchphrase with obvious ticker energy",
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
    const withImg = { ...sampleTweet, images: [{ url: "https://x" }] };
    expect(buildClassifierPrompt(withImg)).toContain("Has image: yes");
  });
});

describe("buildMetadataPrompt", () => {
  it("includes reserved symbols list", () => {
    const prompt = buildMetadataPrompt({
      tweet: sampleTweet,
      classification: sampleClassification,
    });
    expect(prompt).toContain("SOL");
    expect(prompt).toContain("USDC");
    expect(prompt).toContain("BLNK");
  });

  it("includes the corrective hint when given", () => {
    const prompt = buildMetadataPrompt({
      tweet: sampleTweet,
      classification: sampleClassification,
      previousFailureHint: "symbol SOL is reserved",
    });
    expect(prompt).toContain("previous attempt failed");
    expect(prompt).toContain("symbol SOL is reserved");
    expect(prompt).toContain("Fix exactly the failed field");
    expect(prompt).toContain("Do NOT change a valid name");
  });

  it("omits the hint when none given", () => {
    const prompt = buildMetadataPrompt({
      tweet: sampleTweet,
      classification: sampleClassification,
    });
    expect(prompt).not.toContain("previous attempt failed");
  });

  it("includes byte-counting guidance for name and symbol limits", () => {
    const prompt = buildMetadataPrompt({
      tweet: sampleTweet,
      classification: sampleClassification,
    });
    expect(prompt).toContain("<=32 UTF-8 bytes");
    expect(prompt).toContain("ASCII text, this means <=32 characters");
    expect(prompt).toContain("remove low-signal filler words");
    expect(prompt).toContain("symbol is <=10 UTF-8 bytes");
  });

  it("includes classifier context, quoted text, and style choices", () => {
    const prompt = buildMetadataPrompt({
      tweet: {
        ...sampleTweet,
        isQuoteTweet: true,
        quotedTweet: {
          ...sampleTweet,
          id: "q1",
          authorHandle: "pumpfun",
          text: "communities in control?",
        },
      },
      classification: sampleClassification,
    });

    expect(prompt).toContain("Classifier meme read");
    expect(prompt).toContain(sampleClassification.reason);
    expect(prompt).toContain("Quoted tweet author: pumpfun");
    expect(prompt).toContain("communities in control?");
    expect(prompt).toContain("classic-meme-poster");
    expect(prompt).toContain("clean-vector-mascot");
  });
});
