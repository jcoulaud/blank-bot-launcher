import { Keypair } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Metadata } from "../src/brain/metadata.js";
import type { Tweet } from "../src/sources/tweet-source.js";

// Mock the @blankdotbuild/sdk module (ships with extensionless ESM imports
// that strict ESM doesn't resolve; we don't want unit tests touching the
// real SDK internals anyway).
const createMock = vi.fn();
vi.mock("@blankdotbuild/sdk", () => ({
  BlankSdkError: class BlankSdkError extends Error {
    readonly status: number | undefined;
    readonly code: string | undefined;
    readonly details: unknown;

    constructor(message: string, options?: { status?: number; code?: string; details?: unknown }) {
      super(message);
      this.status = options?.status;
      this.code = options?.code;
      this.details = options?.details;
    }
  },
  createBlankClient: vi.fn(),
  createBlankKeypairWallet: vi.fn((kp: Keypair) => ({ publicKey: kp.publicKey })),
  LaunchSubmissionFailedError: class LaunchSubmissionFailedError extends Error {
    readonly signedTransactions: string[] = [];
    readonly submissionIntentId = "";
    readonly launchId = "";
    readonly mintAddress = "";
  },
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
  imageStrategy: "generate",
  imagePrompt: "doge",
};

beforeEach(() => {
  createMock.mockReset();
});

describe("launchToken", () => {
  it("calls SDK with the expected idempotency key and antiSnipe false", async () => {
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
      stakingShareBps: 8000,
    });
    expect(result.mintAddress).toBe("M1");
    expect(result.submission.signature).toBe("sig1");
    expect(createMock).toHaveBeenCalledTimes(1);
    const [input] = createMock.mock.calls[0]!;
    expect(input.idempotencyKey).toBe("blank-bot-t1");
    expect(input.antiSnipeEnabled).toBe(false);
    expect(input.symbol).toBe("DOGE");
    expect(input.metadataUri).toBe("ipfs://meta");
    expect(input.staking).toEqual({ shareBps: 8000 });
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
        stakingShareBps: 8000,
      }),
    ).rejects.toThrow(/rpc timeout/);
  });
});

describe("safeLaunchErrorMessage", () => {
  it("redacts signedTransactions for LaunchSubmissionFailedError", async () => {
    const { LaunchSubmissionFailedError } = await import("@blankdotbuild/sdk");
    const { safeLaunchErrorMessage } = await import("../src/launcher/blank-launcher.js");
    // biome-ignore lint/suspicious/noExplicitAny: mocked constructor accepts no args
    const err = new (LaunchSubmissionFailedError as any)();
    // Simulate populated fields (the mock class lets us mutate readonly via cast)
    Object.assign(err, {
      signedTransactions: ["LEAKED_BASE58_TX_THAT_ANYONE_COULD_BROADCAST"],
      submissionIntentId: "sub_123",
      launchId: "launch_456",
      mintAddress: "MINT_789",
    });
    const out = safeLaunchErrorMessage(err);
    expect(out).not.toContain("LEAKED_BASE58_TX_THAT_ANYONE_COULD_BROADCAST");
    expect(out).toContain("launch_456");
    expect(out).toContain("MINT_789");
    expect(out).toContain("sub_123");
    expect(out).toContain("redacted");
  });

  it("passes regular Error messages through verbatim", async () => {
    const { safeLaunchErrorMessage } = await import("../src/launcher/blank-launcher.js");
    expect(safeLaunchErrorMessage(new Error("network down"))).toBe("network down");
  });

  it("includes SDK error resolver attempts without secrets", async () => {
    const { BlankSdkError } = await import("@blankdotbuild/sdk");
    const { safeLaunchErrorMessage } = await import("../src/launcher/blank-launcher.js");
    const err = new BlankSdkError("metadataUri must resolve", {
      status: 400,
      code: "LAUNCH_BUILD_METADATA_UNRESOLVABLE",
      details: {
        attempts: [
          { host: "blank.mypinata.cloud", reason: "http_status", status: 403 },
          { host: "gateway.pinata.cloud", reason: "http_status", status: 429 },
        ],
      },
    });

    expect(safeLaunchErrorMessage(err)).toBe(
      "metadataUri must resolve code=LAUNCH_BUILD_METADATA_UNRESOLVABLE status=400 attempts=blank.mypinata.cloud:http_status:403,gateway.pinata.cloud:http_status:429",
    );
  });

  it("stringifies non-Error values", async () => {
    const { safeLaunchErrorMessage } = await import("../src/launcher/blank-launcher.js");
    expect(safeLaunchErrorMessage("oops")).toBe("oops");
    expect(safeLaunchErrorMessage(42)).toBe("42");
  });
});
