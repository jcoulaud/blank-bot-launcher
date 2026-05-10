import { describe, expect, it, vi } from "vitest";
import {
  type ClassificationContext,
  generateTokenMetadata,
  type Metadata,
  repairMetadata,
  validateMetadata,
} from "../src/brain/metadata.js";
import type { Tweet } from "../src/sources/tweet-source.js";

const baseTweet = (withImage = false): Tweet => ({
  id: "t1",
  authorHandle: "elonmusk",
  authorId: "1",
  text: "hi",
  createdAt: new Date(),
  media: withImage ? [{ type: "photo", url: "https://x.com/img.jpg" }] : [],
  images: withImage ? [{ url: "https://x.com/img.jpg" }] : [],
  isReply: false,
  isRetweet: false,
  isQuoteTweet: false,
});

const quoteTweetWithImage = (): Tweet => ({
  ...baseTweet(false),
  isQuoteTweet: true,
  quotedTweet: {
    ...baseTweet(true),
    id: "q1",
    authorHandle: "coinnews",
    media: [{ type: "photo", url: "https://pbs.twimg.com/media/quoted.jpg" }],
    images: [{ url: "https://pbs.twimg.com/media/quoted.jpg" }],
  },
});

const jaguarCryptoQuoteTweet = (): Tweet => ({
  ...baseTweet(false),
  id: "2053607573744672791",
  authorHandle: "toly",
  text: "What did a jaguar say to his buddy?\n\nAaah, a talking jaguar",
  isQuoteTweet: true,
  quotedTweet: {
    ...baseTweet(false),
    id: "q-jagpool",
    authorHandle: "JagPool_xyz",
    text: "On behalf of our Jaguar validator, we're proud to have participated as a genesis node in the community Alpenglow cluster bootstrap.",
  },
});

const aiModelNamingTweet = (): Tweet => ({
  ...baseTweet(false),
  authorHandle: "sama",
  text: 'what if we name the next model "goblin"\n\nalmost worth it to make you all happy...',
});

const baseMeta: Metadata = {
  name: "Elon Doge",
  symbol: "EDOGE",
  imageStrategy: "generate",
  imageStyle: "object-icon",
  imagePrompt:
    "Anchor: single gold doge rocket toy. Twist: crater-blue studio backdrop with taped-on astronaut fin, plain background, no caption, no ticker.",
};
const fourByteChar = String.fromCodePoint(0x1f680);
const baseClassification: ClassificationContext = {
  shouldLaunch: true,
  confidence: 0.95,
  launchableMeme: true,
  memeSource: "tweet_text",
  visualAssessment: "none",
  disqualifiers: [],
  reason: "short doge line with obvious ticker energy",
};
const metadataOptions = () => ({
  // biome-ignore lint/suspicious/noExplicitAny: mocked LanguageModel
  model: {} as any,
  classification: baseClassification,
});

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

  it("rejects a name that is empty after metadata cleanup", () => {
    const meta = { ...baseMeta, name: String.fromCharCode(0x200b) };
    const failure = validateMetadata(meta, baseTweet());
    expect(failure?.field).toBe("name");
    expect(failure?.reason).toMatch(/empty/);
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
    delete (meta as { imagePrompt?: string }).imagePrompt;
    const failure = validateMetadata(meta, baseTweet());
    expect(failure?.field).toBe("imageStrategy_consistency");
  });

  it("rejects generic generated image prompts", () => {
    const meta: Metadata = {
      ...baseMeta,
      imagePrompt: 'cartoon meme illustration of "Doge", bold colors, simple shapes',
    };
    const failure = validateMetadata(meta, baseTweet());
    expect(failure?.field).toBe("imagePrompt");
    expect(failure?.reason).toMatch(/Anchor/);
  });

  it("rejects generated image prompts that omit the Anchor/Twist shape", () => {
    const meta: Metadata = {
      ...baseMeta,
      imagePrompt: "single gold doge rocket toy with crater-blue studio backdrop",
    };
    const failure = validateMetadata(meta, baseTweet());
    expect(failure?.field).toBe("imagePrompt");
    expect(failure?.reason).toMatch(/Anchor/);
  });

  it("rejects generate without imageStyle", () => {
    const meta: Metadata = { ...baseMeta, imageStrategy: "generate" };
    delete (meta as { imageStyle?: string }).imageStyle;
    const failure = validateMetadata(meta, baseTweet());
    expect(failure?.field).toBe("imageStyle");
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

  it("rejects generic literal metadata for AI model naming jokes", () => {
    const meta: Metadata = {
      ...baseMeta,
      name: 'model "goblin"',
      symbol: "GOBLIN",
      imageStyle: "meme-character",
      imagePrompt:
        "Anchor: green goblin cartoon character holding a sign. Twist: the sign says MODEL GOBLIN, white background, no ticker.",
    };
    const failure = validateMetadata(meta, aiModelNamingTweet());
    expect(failure?.field).toBe("name");
    expect(failure?.reason).toMatch(/GoblinGPT/i);
  });

  it("accepts product-context metadata for AI model naming jokes", () => {
    const meta: Metadata = {
      ...baseMeta,
      name: "GoblinGPT",
      symbol: "GOBLINGPT",
      imageStyle: "graphic-emblem",
      imagePrompt:
        "Anchor: ChatGPT/OpenAI knot-logo silhouette redrawn as a parody emblem. Twist: the loops become goblin ears, narrowed eyes, and a jagged grin, flat monochrome sticker on white, no caption, no ticker.",
    };
    expect(validateMetadata(meta, aiModelNamingTweet())).toBeNull();
  });

  it("rejects generated prompts that ignore explicit crypto quote context", () => {
    const meta: Metadata = {
      ...baseMeta,
      name: "a talking jaguar",
      symbol: "JAGUAR",
      imageStyle: "graphic-emblem",
      imagePrompt:
        "Anchor: green jaguar head sticker. Twist: mouth open in surprise on a jungle-green background, no caption, no ticker.",
    };
    const failure = validateMetadata(meta, jaguarCryptoQuoteTweet());
    expect(failure?.field).toBe("imagePrompt");
    expect(failure?.reason).toMatch(/crypto-native/);
  });

  it("rejects technical crypto props without a meme or pop-culture anchor", () => {
    const meta: Metadata = {
      ...baseMeta,
      name: "a talking jaguar",
      symbol: "JAGUAR",
      imageStyle: "graphic-emblem",
      imagePrompt:
        "Anchor: crude MEW/BONK-style jaguar token mascot crouched on a tiny Solana validator server rack. Twist: mouth open in deadpan shock at a second jaguar silhouette, Alpenglow-green glow behind node LEDs, no caption, no ticker.",
    };
    const failure = validateMetadata(meta, jaguarCryptoQuoteTweet());
    expect(failure?.field).toBe("imagePrompt");
    expect(failure?.reason).toMatch(/meme or pop-culture anchor/);
  });

  it("accepts prompts that fuse crypto quote context through a meme anchor", () => {
    const meta: Metadata = {
      ...baseMeta,
      name: "a talking jaguar",
      symbol: "JAGUAR",
      imageStyle: "reaction-face",
      imagePrompt:
        "Anchor: canonical Soyjak open-mouth shock face, rough 4chan ink line, round glasses, scraggly beard, pointing finger, plain white background. Twist: jaguar-spotted validator hoodie with a crude Solana-culture patch, Alpenglow-green Solana validator-node LEDs reflected in both huge eyes, with one tiny crude jaguar silhouette perched on the node as prop. No caption, no ticker, no border.",
    };
    expect(validateMetadata(meta, jaguarCryptoQuoteTweet())).toBeNull();
  });

  it("accepts reuse when tweet has an image", () => {
    const meta: Metadata = { ...baseMeta, imageStrategy: "reuse" };
    delete (meta as { imagePrompt?: string }).imagePrompt;
    expect(validateMetadata(meta, baseTweet(true))).toBeNull();
  });

  it("accepts reuse and remix when only the quoted tweet has an image", () => {
    const reuseMeta: Metadata = { ...baseMeta, imageStrategy: "reuse" };
    delete (reuseMeta as { imagePrompt?: string }).imagePrompt;
    expect(validateMetadata(reuseMeta, quoteTweetWithImage())).toBeNull();

    const remixMeta: Metadata = {
      ...baseMeta,
      imageStrategy: "remix",
      remixInstructions: "keep the quoted portrait and apply the tweet joke",
    };
    expect(validateMetadata(remixMeta, quoteTweetWithImage())).toBeNull();
  });

  it("accepts a multi-byte name within 32 bytes", () => {
    // 8 four-byte code points = 32 bytes in UTF-8.
    const meta = { ...baseMeta, name: fourByteChar.repeat(8) };
    expect(validateMetadata(meta, baseTweet())).toBeNull();
  });

  it("rejects a multi-byte name exceeding 32 bytes", () => {
    const meta = { ...baseMeta, name: fourByteChar.repeat(9) };
    const failure = validateMetadata(meta, baseTweet());
    expect(failure?.field).toBe("name");
  });
});

describe("repairMetadata", () => {
  it("prefers high-signal initialisms over generic component words", () => {
    const repaired = repairMetadata({
      ...baseMeta,
      name: "artificial general intelligence",
      symbol: "GENERAL",
      imagePrompt:
        "Anchor: black-and-white robot wojak bust. Twist: exposed wires spilling from a cracked skull on stark white background, no caption, no ticker.",
    });

    expect(repaired.symbol).toBe("AGI");
  });

  it("keeps a stronger word symbol when the initials are not a known ticker hook", () => {
    const repaired = repairMetadata({
      ...baseMeta,
      name: "communities in control?",
      symbol: "CONTROL",
    });

    expect(repaired.symbol).toBe("CONTROL");
  });
});

// Mock generateObject from the AI SDK so retry behavior can be exercised.
const generateObjectMock = vi.hoisted(() => vi.fn());
vi.mock("ai", async (importOriginal) => {
  const mod = (await importOriginal()) as Record<string, unknown>;
  return { ...mod, generateObject: generateObjectMock };
});

function promptTextFromCall(index: number): string {
  const arg = generateObjectMock.mock.calls[index]?.[0] as {
    prompt?: string;
    messages?: Array<{ content?: Array<{ type?: string; text?: string; image?: unknown }> }>;
  };
  if (arg.prompt) return arg.prompt;
  const content = arg.messages?.[0]?.content ?? [];
  return content.find((part) => part.type === "text")?.text ?? "";
}

function callHasImagePart(index: number): boolean {
  const arg = generateObjectMock.mock.calls[index]?.[0] as {
    messages?: Array<{ content?: Array<{ type?: string; image?: unknown }> }>;
  };
  const content = arg.messages?.[0]?.content ?? [];
  return content.some((part) => part.type === "image");
}

describe("generateTokenMetadata retry loop", () => {
  it("returns ok=true on first attempt when validation passes", async () => {
    generateObjectMock.mockReset();
    generateObjectMock.mockResolvedValueOnce({
      object: {
        name: "Doge",
        symbol: "DOGE",
        imageStrategy: "generate",
        imageStyle: "object-icon",
        imagePrompt:
          "Anchor: single gold doge rocket toy. Twist: crater-blue studio backdrop with taped-on astronaut fin, plain background, no caption, no ticker.",
      },
    });
    const result = await generateTokenMetadata(baseTweet(), metadataOptions());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.attempts).toBe(1);
      expect(result.metadata.symbol).toBe("DOGE");
    }
  });

  it("retries with previousFailureHint when first attempt fails validation", async () => {
    generateObjectMock.mockReset();
    // First attempt returns a reserved symbol, so validation fails.
    generateObjectMock.mockResolvedValueOnce({
      object: {
        name: "Sol",
        symbol: "SOL",
        imageStrategy: "generate",
        imageStyle: "graphic-emblem",
        imagePrompt:
          "Anchor: molten gold sun medallion. Twist: crooked sunglasses and teal summer backdrop, flat sticker edge, no caption, no ticker.",
      },
    });
    // Second attempt fixes it
    generateObjectMock.mockResolvedValueOnce({
      object: {
        name: "Sol",
        symbol: "SOLAR",
        imageStrategy: "generate",
        imageStyle: "graphic-emblem",
        imagePrompt:
          "Anchor: molten gold sun medallion. Twist: crooked sunglasses and teal summer backdrop, flat sticker edge, no caption, no ticker.",
      },
    });
    const result = await generateTokenMetadata(baseTweet(), metadataOptions());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.attempts).toBe(2);
    // Second call should have received a prompt mentioning the previous failure
    expect(promptTextFromCall(1)).toContain("previous attempt failed");
  });

  it("retries literal AI-model naming outputs toward a product-context coinage", async () => {
    generateObjectMock.mockReset();
    generateObjectMock.mockResolvedValueOnce({
      object: {
        name: 'model "goblin"',
        symbol: "GOBLIN",
        imageStrategy: "generate",
        imageStyle: "meme-character",
        imagePrompt:
          "Anchor: green goblin cartoon character holding a sign. Twist: the sign says MODEL GOBLIN, white background, no ticker.",
      },
    });
    generateObjectMock.mockResolvedValueOnce({
      object: {
        name: "GoblinGPT",
        symbol: "GOBLINGPT",
        imageStrategy: "generate",
        imageStyle: "graphic-emblem",
        imagePrompt:
          "Anchor: ChatGPT/OpenAI knot-logo silhouette redrawn as a parody emblem. Twist: the loops become goblin ears, narrowed eyes, and a jagged grin, flat monochrome sticker on white, no caption, no ticker.",
      },
    });

    const result = await generateTokenMetadata(aiModelNamingTweet(), metadataOptions());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.metadata.name).toBe("GoblinGPT");
      expect(result.metadata.symbol).toBe("GOBLINGPT");
    }
    expect(promptTextFromCall(1)).toContain("GoblinGPT");
  });

  it("retries generated image prompts that drop crypto quote context", async () => {
    generateObjectMock.mockReset();
    generateObjectMock.mockResolvedValueOnce({
      object: {
        name: "a talking jaguar",
        symbol: "JAGUAR",
        imageStrategy: "generate",
        imageStyle: "graphic-emblem",
        imagePrompt:
          "Anchor: crude MEW/BONK-style jaguar token mascot crouched on a tiny Solana validator server rack. Twist: mouth open in deadpan shock at a second jaguar silhouette, Alpenglow-green glow behind node LEDs, no caption, no ticker.",
      },
    });
    generateObjectMock.mockResolvedValueOnce({
      object: {
        name: "a talking jaguar",
        symbol: "JAGUAR",
        imageStrategy: "generate",
        imageStyle: "reaction-face",
        imagePrompt:
          "Anchor: canonical Soyjak open-mouth shock face, rough 4chan ink line, round glasses, scraggly beard, pointing finger, plain white background. Twist: jaguar-spotted validator hoodie with a crude Solana-culture patch, Alpenglow-green Solana validator-node LEDs reflected in both huge eyes, with one tiny crude jaguar silhouette perched on the node as prop. No caption, no ticker, no border.",
      },
    });

    const result = await generateTokenMetadata(jaguarCryptoQuoteTweet(), metadataOptions());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.attempts).toBe(2);
      expect(result.metadata.name).toBe("a talking jaguar");
      expect(result.metadata.imageStyle).toBe("reaction-face");
    }
    expect(promptTextFromCall(1)).toContain("meme or pop-culture anchor");
  });

  it("returns ok=false after maxAttempts when both attempts fail", async () => {
    generateObjectMock.mockReset();
    generateObjectMock.mockResolvedValue({
      object: {
        name: "x",
        symbol: "USDC",
        imageStrategy: "generate",
        imageStyle: "graphic-emblem",
        imagePrompt: "x",
      },
    });
    const result = await generateTokenMetadata(baseTweet(), metadataOptions());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.attempts).toBe(2);
      expect(result.finalFailure.field).toBe("symbol");
    }
  });

  it("normalizes symbol to uppercase between LLM output and validator", async () => {
    generateObjectMock.mockReset();
    generateObjectMock.mockResolvedValueOnce({
      object: {
        name: "Doge",
        symbol: "doge",
        imageStrategy: "generate",
        imageStyle: "object-icon",
        imagePrompt:
          "Anchor: single gold doge rocket toy. Twist: crater-blue studio backdrop with taped-on astronaut fin, plain background, no caption, no ticker.",
      },
    });
    const result = await generateTokenMetadata(baseTweet(), metadataOptions());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.metadata.symbol).toBe("DOGE");
  });

  it("repairs model output when the name and symbol exceed byte limits", async () => {
    generateObjectMock.mockReset();
    generateObjectMock.mockResolvedValueOnce({
      object: {
        name: "cornerstone of my financial future",
        symbol: "CORNERSTONE",
        imageStrategy: "reuse",
      },
    });

    const result = await generateTokenMetadata(baseTweet(true), metadataOptions());

    expect(result.ok).toBe(true);
    expect(generateObjectMock).toHaveBeenCalledTimes(1);
    if (result.ok) {
      expect(result.metadata.name).toBe("cornerstone of financial future");
      expect(result.metadata.symbol).toBe("FUTURE");
      expect(Buffer.byteLength(result.metadata.name, "utf8")).toBeLessThanOrEqual(32);
      expect(Buffer.byteLength(result.metadata.symbol, "utf8")).toBeLessThanOrEqual(10);
    }
  });

  it("sends quoted tweet media to the metadata model", async () => {
    generateObjectMock.mockReset();
    generateObjectMock.mockResolvedValueOnce({
      object: {
        name: "completely grey before launch",
        symbol: "GREY",
        imageStrategy: "remix",
        remixInstructions: "keep the quoted portrait and make the hair grey",
      },
    });

    const result = await generateTokenMetadata(quoteTweetWithImage(), metadataOptions());

    expect(result.ok).toBe(true);
    expect(promptTextFromCall(0)).toContain("Has image: yes (quoted tweet)");
    expect(callHasImagePart(0)).toBe(true);
  });
});
