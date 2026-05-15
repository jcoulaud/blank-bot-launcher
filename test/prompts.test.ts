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

  it("rejects when the author explicitly mocks the action a launch would represent", () => {
    const prompt = buildClassifierPrompt(sampleTweet);
    expect(prompt).toContain("author_rejects_premise");
    expect(prompt).toContain("Author rejects the premise");
    expect(prompt).toContain("#nokings");
    expect(prompt).toContain("toly");
    expect(prompt).toContain("would BE the joke at the bot's expense");
  });

  it("rejects hashtag-only, single-word, and interjection-only quote reactions", () => {
    const prompt = buildClassifierPrompt(sampleTweet);
    expect(prompt).toContain("hashtag, a single word, an interjection");
    expect(prompt).toContain("the source must MAKE the meme, not point at one");
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
    expect(prompt).toContain("chrome brains");
    expect(prompt).toContain("Solana-trenches");
  });

  it("teaches non-obvious acronym extraction with the AGI brainlet example", () => {
    const prompt = buildMetadataPrompt({
      tweet: sampleTweet,
      classification: sampleClassification,
    });

    expect(prompt).toContain("autistic genius intelligence");
    expect(prompt).toContain("initialism-completion");
    expect(prompt).toContain("BOTTOMLESS PIT");
    expect(prompt).toContain("brainlet");
  });

  it("teaches product-context naming and brand-remix art for AI model jokes", () => {
    const prompt = buildMetadataPrompt({
      tweet: sampleTweet,
      classification: sampleClassification,
    });

    expect(prompt).toContain("GoblinGPT");
    expect(prompt).toContain("GOBLINGPT");
    expect(prompt).toContain("ChatGPT/OpenAI knot");
    expect(prompt).toContain("product-context coinage");
    expect(prompt).toContain("generic creature holding a sign");
  });

  it("requires cultural anchor + tweet-specific twist for generated images", () => {
    const prompt = buildMetadataPrompt({
      tweet: sampleTweet,
      classification: sampleClassification,
    });

    expect(prompt).toContain("cultural anchor");
    expect(prompt).toContain("twist");
    expect(prompt).toContain("photo-collage");
    expect(prompt).toContain("Punchline-as-visual-prop");
    expect(prompt).toContain("Anchor/Twist shape is validated");
  });

  it("requires generated images to preserve explicit crypto quote context", () => {
    const prompt = buildMetadataPrompt({
      tweet: {
        ...sampleTweet,
        id: "2053607573744672791",
        authorHandle: "toly",
        text: "What did a jaguar say to his buddy?\n\nAaah, a talking jaguar",
        isQuoteTweet: true,
        quotedTweet: {
          ...sampleTweet,
          id: "q1",
          authorHandle: "JagPool_xyz",
          text: "On behalf of our Jaguar validator, we're proud to have participated as a genesis node in the community Alpenglow cluster bootstrap.",
        },
      },
      classification: sampleClassification,
    });

    expect(prompt).toContain("Quote/context rule");
    expect(prompt).toContain("strong meme/pop-culture anchor");
    expect(prompt).toContain("Soyjak/Wojak shock-face");
    expect(prompt).toContain("standalone wildlife sticker");
    expect(prompt).toContain("jaguar-on-server mascot");
  });

  it("documents the joke-text exception and the no-ticker rule", () => {
    const prompt = buildMetadataPrompt({
      tweet: sampleTweet,
      classification: sampleClassification,
    });

    expect(prompt).toContain("Text exception");
    expect(prompt).toContain("ticker / symbol MUST NOT appear");
    expect(prompt).toContain("Impact-font");
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
    expect(prompt).toContain("do not default to wojak");
  });

  it("teaches political/civics/protest anchors as a first-class anchor lane", () => {
    const prompt = buildMetadataPrompt({
      tweet: sampleTweet,
      classification: sampleClassification,
    });

    expect(prompt).toContain("Politics / civics / protest");
    expect(prompt).toContain("Phrygian");
    expect(prompt).toContain("Liberty cap");
    expect(prompt).toContain("sans-culottes");
    expect(prompt).toContain("Anonymous");
    expect(prompt).toContain("Guy Fawkes");
    expect(prompt).toContain("NEVER a generic crossed-out icon");
  });

  it("teaches TCG / collection-card and other non-crypto anchor lanes", () => {
    const prompt = buildMetadataPrompt({
      tweet: sampleTweet,
      classification: sampleClassification,
    });

    expect(prompt).toContain("Trading-card / TCG");
    expect(prompt).toContain("Pokemon card frame");
    expect(prompt).toContain("Magic-the-Gathering");
    expect(prompt).toContain("Topps");
    expect(prompt).toContain("Sports / fandom");
    expect(prompt).toContain("Music / album / subculture");
    expect(prompt).toContain("News cycle / tabloid");
    expect(prompt).toContain("Religion / philosophy / academia");
  });

  it("explicitly bans literal-direct-symbol anchors as AI slop", () => {
    const prompt = buildMetadataPrompt({
      tweet: sampleTweet,
      classification: sampleClassification,
    });

    expect(prompt).toContain("Anti-literal symbolism rule");
    expect(prompt).toContain("crossed-out crown");
    expect(prompt).toContain("literal moon");
    expect(prompt).toContain("AI slop");
  });

  it("includes a political-anchor worked example with a specific cultural artifact, not a generic symbol", () => {
    const prompt = buildMetadataPrompt({
      tweet: sampleTweet,
      classification: sampleClassification,
    });

    expect(prompt).toContain("trenches voted me in");
    expect(prompt).toContain("Phrygian/Liberty cap");
    expect(prompt).toContain("Sans-Culottes silhouette");
    expect(prompt).toContain("tricolor");
  });

  it("includes a TCG/Pokemon-card worked example demonstrating the frame-as-anchor pattern", () => {
    const prompt = buildMetadataPrompt({
      tweet: sampleTweet,
      classification: sampleClassification,
    });

    expect(prompt).toContain("Charizard of L2s");
    expect(prompt).toContain("Pokemon trading-card frame");
    expect(prompt).toContain("HP corner");
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
