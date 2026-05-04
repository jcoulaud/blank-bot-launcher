import { Keypair } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Metadata } from "../src/brain/metadata.js";
import type { Tweet } from "../src/sources/tweet-source.js";

// Mock the @blankdotbuild/sdk module (ships with extensionless ESM imports
// that strict ESM doesn't resolve; we don't want unit tests touching the
// real SDK internals anyway).
const createMock = vi.fn();
vi.mock("@blankdotbuild/sdk", () => ({
  createBlankClient: vi.fn(),
  createBlankKeypairWallet: vi.fn((kp: Keypair) => ({ publicKey: kp.publicKey })),
}));

const tweet: Tweet = {
  id: "t1",
  authorHandle: "elonmusk",
  authorId: "1",
  text: "doge",
  createdAt: new Date(),
  images: [],
  isReply: false,
  isRetweet: false,
  isQuoteTweet: false,
};

const meta: Metadata = {
  name: "Doge",
  symbol: "DOGE",
  description: "memes",
  imageStrategy: "generate",
  imagePrompt: "doge",
};

beforeEach(() => {
  createMock.mockReset();
});

describe("launchToken", () => {
  it("calls SDK with the expected idempotency key and antiSnipe true", async () => {
    const { launchToken } = await import("../src/launcher/blank-launcher.js");
    createMock.mockResolvedValue({
      launchId: "L1",
      mintAddress: "M1",
      poolAddress: "P1",
      feeCollector: "F1",
      stakingPoolAddress: null,
      status: "submitted" as const,
      submission: { kind: "rpc" as const, signature: "sig1", signatures: ["sig1"] },
    });
    const result = await launchToken({
      // biome-ignore lint/suspicious/noExplicitAny: minimal client stub
      client: { launch: { create: createMock } } as any,
      wallet: Keypair.generate(),
      tweet,
      metadata: meta,
      metadataUri: "ipfs://meta",
    });
    expect(result.mintAddress).toBe("M1");
    expect(result.submission.signature).toBe("sig1");
    expect(createMock).toHaveBeenCalledTimes(1);
    const [input] = createMock.mock.calls[0]!;
    expect(input.idempotencyKey).toBe("blank-bot-t1");
    expect(input.antiSnipeEnabled).toBe(true);
    expect(input.symbol).toBe("DOGE");
    expect(input.metadataUri).toBe("ipfs://meta");
  });

  it("propagates SDK errors with logging", async () => {
    const { launchToken } = await import("../src/launcher/blank-launcher.js");
    createMock.mockRejectedValue(new Error("rpc timeout"));
    await expect(
      launchToken({
        // biome-ignore lint/suspicious/noExplicitAny: minimal client stub
        client: { launch: { create: createMock } } as any,
        wallet: Keypair.generate(),
        tweet,
        metadata: meta,
        metadataUri: "ipfs://meta",
      }),
    ).rejects.toThrow(/rpc timeout/);
  });
});
