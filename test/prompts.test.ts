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
  media: [],
  images: [],
  isReply: false,
  isRetweet: false,
  isQuoteTweet: false,
};
const sampleClassification = {
  shouldLaunch: true,
  confidence: 0.95,
  launchableMeme: true,
  memeSource: "tweet_text" as const,
  visualAssessment: "none" as const,
  disqualifiers: [],
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
    const withImg = {
      ...sampleTweet,
      media: [{ type: "photo" as const, url: "https://x" }],
      images: [{ url: "https://x" }],
    };
    expect(buildClassifierPrompt(withImg)).toContain("Has image: yes");
  });

  it("treats a quoted-tweet image as launch visual context", () => {
    const withQuotedImg: Tweet = {
      ...sampleTweet,
      isQuoteTweet: true,
      quotedTweet: {
        ...sampleTweet,
        id: "q1",
        media: [{ type: "photo", url: "https://pbs.twimg.com/media/quoted.jpg" }],
        images: [{ url: "https://pbs.twimg.com/media/quoted.jpg" }],
      },
    };
    expect(buildClassifierPrompt(withQuotedImg)).toContain("Has image: yes (quoted tweet)");
  });

  it("calibrates market charts, AI screenshots, and image-text extraction as rejects", () => {
    const prompt = buildClassifierPrompt(sampleTweet);
    expect(prompt).toContain("market_data_or_chart");
    expect(prompt).toContain("app_or_ai_screenshot");
    expect(prompt).toContain("image_text_extraction_only");
    expect(prompt).toContain(
      "Do NOT launch a token named after any asset/ticker appearing inside them",
    );
    expect(prompt).toContain("emoji reaction to an analytics chart");
  });

  it("requires quote tweets to author the meme in the source text", () => {
    const prompt = buildClassifierPrompt(sampleTweet);
    expect(prompt).toContain("The source tweet must author the meme");
    expect(prompt).toContain("👇🎶🎤");
    expect(prompt).toContain('Use "none" when the only launchable material is in the quoted tweet');
    expect(prompt).not.toContain('quoted_tweet"');
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

  it("calibrates acronym tickers and avoids generic AI-brain art", () => {
    const prompt = buildMetadataPrompt({
      tweet: sampleTweet,
      classification: sampleClassification,
    });

    expect(prompt).toContain("artificial general intelligence");
    expect(prompt).toContain('symbol="AGI"');
    expect(prompt).toContain("GENERAL");
    expect(prompt).toContain("floating chrome brains");
    expect(prompt).toContain("CT/Pump trenches");
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
    expect(prompt).toContain("Classifier hard-gate details");
    expect(prompt).toContain(sampleClassification.reason);
    expect(prompt).toContain("Quoted tweet author: pumpfun");
    expect(prompt).toContain("communities in control?");
    expect(prompt).toContain("Quoted tweet has image: no");
    expect(prompt).toContain("graphic-emblem");
    expect(prompt).toContain("studio-photo");
    expect(prompt).toContain("Do NOT force BONK/PEPE/Wojak/Doge/Chad");
  });

  it("marks quoted-tweet media as available for metadata image strategy", () => {
    const prompt = buildMetadataPrompt({
      tweet: {
        ...sampleTweet,
        isQuoteTweet: true,
        quotedTweet: {
          ...sampleTweet,
          id: "q1",
          authorHandle: "coinnews",
          text: "quoted post with portrait",
          media: [{ type: "photo", url: "https://pbs.twimg.com/media/quoted.jpg" }],
          images: [{ url: "https://pbs.twimg.com/media/quoted.jpg" }],
        },
      },
      classification: sampleClassification,
    });

    expect(prompt).toContain("Has image: yes (quoted tweet)");
    expect(prompt).toContain("Quoted tweet has image: yes");
    expect(prompt).toContain("remix that image");
    expect(prompt).toContain("Do NOT replace the source subject with a generic character");
  });
});
