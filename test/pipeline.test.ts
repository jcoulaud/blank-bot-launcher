// End-to-end runPipeline coverage with mocked LLM, fetch, and SDK.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Connection, Keypair } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/config.js";
import type { Tweet } from "../src/sources/tweet-source.js";
import { Store } from "../src/store/db.js";

const generateObjectMock = vi.hoisted(() => vi.fn());
vi.mock("ai", async (importOriginal) => {
  const mod = (await importOriginal()) as Record<string, unknown>;
  return { ...mod, generateObject: generateObjectMock };
});

const blankCreateMock = vi.hoisted(() => vi.fn());
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
  createBlankClient: vi.fn(() => ({ launch: { create: blankCreateMock } })),
  createBlankKeypairWallet: vi.fn((kp: Keypair) => ({ publicKey: kp.publicKey })),
  LaunchSubmissionFailedError: class LaunchSubmissionFailedError extends Error {
    readonly signedTransactions: string[] = [];
    readonly submissionIntentId = "";
    readonly launchId = "";
    readonly mintAddress = "";
  },
}));

vi.mock("node:dns/promises", () => ({
  // Public IP so SSRF guard accepts twimg hosts.
  lookup: vi.fn().mockResolvedValue({ address: "199.59.148.246", family: 4 }),
}));

const env: Env = {
  SOLANA_PRIVATE_KEY: "x",
  BLANK_API_KEY: "x",
  BLANK_API_BASE_URL: "https://api.blank.build",
  X_BEARER_TOKEN: "x",
  GOOGLE_GENERATIVE_AI_API_KEY: "x",
  PINATA_JWT: "jwt",
  LLM_MODEL: "gemini-2.5-flash",
  IMAGE_MODEL: "gemini-2.5-flash-image",
  CLASSIFIER_THRESHOLD: 0.85,
  MAX_SOL_PER_LAUNCH: 0.05,
  MAX_LAUNCHES_PER_DAY: 3,
  MAX_SOL_PER_DAY: 0.15,
  WARN_IF_BALANCE_ABOVE_SOL: 2,
  RPC_URL: "https://x",
  ACCOUNTS_FILE: "x",
  SHUTDOWN_TIMEOUT_S: 90,
  DB_PATH: "x",
  LOG_LEVEL: "info",
  SKIP_OLDER_THAN_S: 300,
  STAKING_SHARE_BPS: 8000,
  PENDING_LOCK_STALE_S: 300,
  CIRCUIT_BREAKER_WINDOW_S: 900,
  CIRCUIT_BREAKER_PAUSE_S: 60,
  MAX_CONSECUTIVE_PROVIDER_ERRORS: 3,
  MAX_CONSECUTIVE_IPFS_ERRORS: 3,
  MAX_CONSECUTIVE_LAUNCH_ERRORS: 2,
  MAX_X_API_USD_PER_DAY: 25,
};

const VALID_1X1_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);

function fakeTweet(): Tweet {
  return {
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
}

function fakeConnection(
  balanceSol: number,
  costLamportsBySignature: Record<string, number> = { SIG_XYZ: 12_300_000 },
): Connection {
  // measureTxCostsSol expects pre/post balances on the wallet's static account
  // key. We don't know the wallet's pubkey here, so the helper looks up index
  // 0 (which `findIndex` will use after we mock staticAccountKeys to contain
  // a single key matching the payer). The test wallet is the only signer, so
  // index 0 in the mocked tx is fine.
  const lamports = balanceSol * 1_000_000_000;
  return {
    getBalance: vi.fn().mockResolvedValue(lamports),
    getTransaction: vi.fn().mockImplementation(async (signature: string) => {
      const costLamports = costLamportsBySignature[signature] ?? 12_300_000;
      return {
        meta: {
          preBalances: [lamports],
          postBalances: [lamports - costLamports],
        },
        transaction: {
          message: {
            // findIndex(k => k.equals(payer)): return a stub that always equals.
            staticAccountKeys: [{ equals: () => true }],
          },
        },
      };
    }),
  } as unknown as Connection;
}

function geminiImageResponse(): Response {
  return new Response(
    JSON.stringify({
      candidates: [
        {
          content: {
            parts: [
              {
                inlineData: { mimeType: "image/png", data: VALID_1X1_PNG.toString("base64") },
              },
            ],
          },
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function pinataResponse(cid: string): Response {
  return new Response(JSON.stringify({ data: { cid } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function metadataGatewayResponse(): Response {
  return new Response(
    JSON.stringify({
      name: "Doge to the moon",
      symbol: "DOGE",
      image: "ipfs://QmImage",
      twitter: "https://x.com/elonmusk/status/t1",
      website: "https://x.com/elonmusk/status/t1",
      createdOn: "blank.build",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function classificationObject(overrides: Record<string, unknown> = {}) {
  return {
    shouldLaunch: true,
    confidence: 0.95,
    launchableMeme: true,
    memeSource: "tweet_text",
    visualAssessment: "none",
    disqualifiers: [],
    reason: "memeable",
    ...overrides,
  };
}

function setupHappyMocks(
  submission = { kind: "rpc", signature: "SIG_XYZ", signatures: ["SIG_XYZ"] },
) {
  generateObjectMock.mockReset();
  blankCreateMock.mockReset();
  // classify
  generateObjectMock.mockResolvedValueOnce({
    object: classificationObject(),
  });
  // metadata
  generateObjectMock.mockResolvedValueOnce({
    object: {
      name: "Doge to the moon",
      symbol: "DOGE",
      imageStrategy: "generate",
      imageStyle: "object-icon",
      imagePrompt: "single gold doge rocket toy with crater-blue studio backdrop",
    },
  });
  // image generate + 2 pinata uploads
  globalThis.fetch = vi
    .fn()
    .mockResolvedValueOnce(geminiImageResponse())
    .mockResolvedValueOnce(pinataResponse("QmImage"))
    .mockResolvedValueOnce(pinataResponse("QmMeta"))
    .mockResolvedValueOnce(metadataGatewayResponse()) as never;
  blankCreateMock.mockResolvedValue({
    launchId: "L1",
    mintAddress: "MINT_ABC",
    poolAddress: "P1",
    feeCollector: "F1",
    stakingPoolAddress: null,
    status: "submitted",
    submission,
  });
}

function promptTextFromGenerateObjectCall(index: number): string {
  const arg = generateObjectMock.mock.calls[index]?.[0] as {
    prompt?: string;
    messages?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
  };
  if (arg.prompt) return arg.prompt;
  return arg.messages?.[0]?.content?.find((part) => part.type === "text")?.text ?? "";
}

describe("runPipeline integration", () => {
  let tmp: string;
  let store: Store;
  const wallet = Keypair.generate();
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "blank-bot-pipeline-test-"));
    store = new Store(join(tmp, "test.db"));
  });
  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
    globalThis.fetch = originalFetch;
    vi.resetModules();
  });

  it("skips tweets with attached video before classification", async () => {
    generateObjectMock.mockReset();
    blankCreateMock.mockReset();
    const { runPipeline } = await import("../src/pipeline.js");
    const result = await runPipeline(
      { ...fakeTweet(), media: [{ type: "video" }] },
      {
        env,
        store,
        connection: fakeConnection(1),
        wallet,
        // biome-ignore lint/suspicious/noExplicitAny: model is mocked
        llmModel: {} as any,
        // biome-ignore lint/suspicious/noExplicitAny: client built via mocked SDK
        blankClient: { launch: { create: blankCreateMock } } as any,
        dryRun: false,
        force: false,
      },
    );

    expect(result.decision).toBe("skipped_validation");
    expect(result.reason).toBe("video_media_attached");
    expect(generateObjectMock).not.toHaveBeenCalled();
    expect(blankCreateMock).not.toHaveBeenCalled();
    const seen = store.recentSeen(10);
    expect(seen[0]?.decision).toBe("skipped_validation");
    expect(seen[0]?.reason).toBe("video_media_attached");
  });

  it("skips emoji-only quote reactions before classification", async () => {
    generateObjectMock.mockReset();
    blankCreateMock.mockReset();
    const { runPipeline } = await import("../src/pipeline.js");
    const result = await runPipeline(
      {
        ...fakeTweet(),
        text: "👇🎶🎤 https://t.co/quoted",
        isQuoteTweet: true,
        quotedTweet: {
          ...fakeTweet(),
          id: "q1",
          authorHandle: "roaringpepe",
          text: "Why should communism always be lower case?\nSo that it's not capitalized.",
        },
      },
      {
        env,
        store,
        connection: fakeConnection(1),
        wallet,
        // biome-ignore lint/suspicious/noExplicitAny: model is mocked
        llmModel: {} as any,
        // biome-ignore lint/suspicious/noExplicitAny: client built via mocked SDK
        blankClient: { launch: { create: blankCreateMock } } as any,
        dryRun: false,
        force: false,
      },
    );

    expect(result.decision).toBe("skipped_validation");
    expect(result.reason).toBe("quote_reaction_only");
    expect(generateObjectMock).not.toHaveBeenCalled();
    expect(blankCreateMock).not.toHaveBeenCalled();
    const seen = store.recentSeen(10);
    expect(seen[0]?.decision).toBe("skipped_validation");
    expect(seen[0]?.reason).toBe("quote_reaction_only");
  });

  it("happy path: classify to metadata to image to IPFS to launch to commit, counter +1", async () => {
    setupHappyMocks();
    const { runPipeline } = await import("../src/pipeline.js");
    await runPipeline(fakeTweet(), {
      env,
      store,
      connection: fakeConnection(1),
      wallet,
      // biome-ignore lint/suspicious/noExplicitAny: model is mocked
      llmModel: {} as any,
      // biome-ignore lint/suspicious/noExplicitAny: client built via mocked SDK
      blankClient: { launch: { create: blankCreateMock } } as any,
      dryRun: false,
      force: false,
    });
    const launches = store.recentLaunches(10);
    expect(launches).toHaveLength(1);
    expect(launches[0]?.mint).toBe("MINT_ABC");
    expect(launches[0]?.tx_signature).toBe("SIG_XYZ");
    expect(launches[0]?.sol_spent).toBeCloseTo(0.0123);
    expect(blankCreateMock).toHaveBeenCalledTimes(1);
    const metadataPrompt = promptTextFromGenerateObjectCall(1);
    expect(metadataPrompt).toContain("Classifier meme read");
    expect(metadataPrompt).toContain("memeable");
    expect(store.getDailyCounter(Date.now()).launches_count).toBe(1);
    expect(store.getDailyCounter(Date.now()).sol_spent).toBeCloseTo(0.0123);
    expect(store.hasSeen("t1")).toBe(true);
  });

  it("sums exact launch cost across every submitted SDK transaction", async () => {
    setupHappyMocks({
      kind: "jito",
      signature: "SIG_A",
      signatures: ["SIG_A", "SIG_B"],
    });
    const connection = fakeConnection(1, {
      SIG_A: 12_300_000,
      SIG_B: 7_000_000,
    });
    const { runPipeline } = await import("../src/pipeline.js");
    await runPipeline(fakeTweet(), {
      env,
      store,
      connection,
      wallet,
      // biome-ignore lint/suspicious/noExplicitAny: model is mocked
      llmModel: {} as any,
      // biome-ignore lint/suspicious/noExplicitAny: client built via mocked SDK
      blankClient: { launch: { create: blankCreateMock } } as any,
      dryRun: false,
      force: false,
    });

    const launches = store.recentLaunches(10);
    expect(launches).toHaveLength(1);
    expect(launches[0]?.tx_signature).toBe("SIG_A");
    expect(launches[0]?.sol_spent).toBeCloseTo(0.0193);
    expect(store.getDailyCounter(Date.now()).sol_spent).toBeCloseTo(0.0193);
    expect(connection.getTransaction).toHaveBeenCalledWith("SIG_A", expect.any(Object));
    expect(connection.getTransaction).toHaveBeenCalledWith("SIG_B", expect.any(Object));
  });

  it("low confidence below threshold records skipped_low_score and does not launch", async () => {
    generateObjectMock.mockReset();
    generateObjectMock.mockResolvedValueOnce({
      object: classificationObject({
        shouldLaunch: false,
        confidence: 0.2,
        launchableMeme: false,
        memeSource: "none",
        disqualifiers: ["no_self_contained_joke"],
        reason: "weak signal",
      }),
    });
    const { runPipeline } = await import("../src/pipeline.js");
    await runPipeline(fakeTweet(), {
      env,
      store,
      connection: fakeConnection(1),
      wallet,
      // biome-ignore lint/suspicious/noExplicitAny: mocked
      llmModel: {} as any,
      // biome-ignore lint/suspicious/noExplicitAny: mocked
      blankClient: { launch: { create: blankCreateMock } } as any,
      dryRun: false,
      force: false,
    });
    expect(store.recentLaunches(10)).toHaveLength(0);
    const seen = store.recentSeen(10);
    expect(seen[0]?.decision).toBe("skipped_low_score");
    expect(store.getDailyCounter(Date.now()).launches_count).toBe(0);
  });

  it("hard-rejects chart and screenshot disqualifiers before metadata or launch", async () => {
    generateObjectMock.mockReset();
    blankCreateMock.mockReset();
    generateObjectMock.mockResolvedValueOnce({
      object: classificationObject({
        confidence: 0.95,
        visualAssessment: "market_data_or_chart",
        disqualifiers: ["market_data_or_chart", "no_self_contained_joke"],
        reason: "emoji reaction to an analytics chart, not a meme",
      }),
    });
    const { runPipeline } = await import("../src/pipeline.js");
    const result = await runPipeline(
      {
        ...fakeTweet(),
        text: "look at this",
        isQuoteTweet: true,
        quotedTweet: {
          ...fakeTweet(),
          id: "q1",
          authorHandle: "lochie_sol",
          text: "Solana continues to attract some of the strongest builders in crypto.",
          images: [{ url: "https://pbs.twimg.com/media/revenue-chart.jpg" }],
        },
      },
      {
        env,
        store,
        connection: fakeConnection(1),
        wallet,
        // biome-ignore lint/suspicious/noExplicitAny: mocked
        llmModel: {} as any,
        // biome-ignore lint/suspicious/noExplicitAny: mocked
        blankClient: { launch: { create: blankCreateMock } } as any,
        dryRun: false,
        force: false,
      },
    );

    expect(result.decision).toBe("skipped_low_score");
    expect(result.reason).toContain("analytics chart");
    expect(generateObjectMock).toHaveBeenCalledTimes(1);
    expect(blankCreateMock).not.toHaveBeenCalled();
    expect(store.recentLaunches(10)).toHaveLength(0);
  });

  it("IPFS failure rolls back the reservation", async () => {
    generateObjectMock.mockReset();
    blankCreateMock.mockReset();
    generateObjectMock.mockResolvedValueOnce({
      object: classificationObject(),
    });
    generateObjectMock.mockResolvedValueOnce({
      object: {
        name: "Doge",
        symbol: "DOGE",
        imageStrategy: "generate",
        imageStyle: "object-icon",
        imagePrompt: "single gold doge rocket toy with crater-blue studio backdrop",
      },
    });
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(geminiImageResponse())
      // First Pinata call fails
      .mockResolvedValueOnce(new Response("upstream", { status: 500 })) as never;
    const { runPipeline } = await import("../src/pipeline.js");
    await runPipeline(fakeTweet(), {
      env,
      store,
      connection: fakeConnection(1),
      wallet,
      // biome-ignore lint/suspicious/noExplicitAny: mocked
      llmModel: {} as any,
      // biome-ignore lint/suspicious/noExplicitAny: mocked
      blankClient: { launch: { create: blankCreateMock } } as any,
      dryRun: false,
      force: false,
    });
    expect(store.recentLaunches(10)).toHaveLength(0);
    expect(store.getDailyCounter(Date.now()).launches_count).toBe(0);
    const seen = store.recentSeen(10);
    expect(seen[0]?.decision).toBe("skipped_error");
    expect(seen[0]?.reason).toMatch(/ipfs/);
  });

  it("SDK launch failure rolls back the reservation", async () => {
    setupHappyMocks();
    blankCreateMock.mockReset();
    blankCreateMock.mockRejectedValue(new Error("rpc timeout"));
    const { runPipeline } = await import("../src/pipeline.js");
    await runPipeline(fakeTweet(), {
      env,
      store,
      connection: fakeConnection(1),
      wallet,
      // biome-ignore lint/suspicious/noExplicitAny: mocked
      llmModel: {} as any,
      // biome-ignore lint/suspicious/noExplicitAny: mocked
      blankClient: { launch: { create: blankCreateMock } } as any,
      dryRun: false,
      force: false,
    });
    expect(store.recentLaunches(10)).toHaveLength(0);
    expect(store.getDailyCounter(Date.now()).launches_count).toBe(0);
    const seen = store.recentSeen(10);
    expect(seen[0]?.decision).toBe("skipped_error");
    expect(seen[0]?.reason).toMatch(/launch/);
  });

  it("dry-run skips SDK call, records dry_run decision, no counter bump", async () => {
    setupHappyMocks();
    blankCreateMock.mockReset();
    const { runPipeline } = await import("../src/pipeline.js");
    await runPipeline(fakeTweet(), {
      env,
      store,
      connection: fakeConnection(1),
      wallet,
      // biome-ignore lint/suspicious/noExplicitAny: mocked
      llmModel: {} as any,
      blankClient: null,
      dryRun: true,
      force: false,
    });
    expect(blankCreateMock).not.toHaveBeenCalled();
    expect(store.recentLaunches(10)).toHaveLength(0);
    expect(store.getDailyCounter(Date.now()).launches_count).toBe(0);
    expect(store.recentSeen(10)[0]?.decision).toBe("dry_run");
  });

  it("backtest dry-run records generated output and skips safety, IPFS, and SDK", async () => {
    generateObjectMock.mockReset();
    blankCreateMock.mockReset();
    generateObjectMock.mockResolvedValueOnce({
      object: classificationObject(),
    });
    generateObjectMock.mockResolvedValueOnce({
      object: {
        name: "Doge to the moon",
        symbol: "DOGE",
        imageStrategy: "generate",
        imageStyle: "object-icon",
        imagePrompt: "single gold doge rocket toy with crater-blue studio backdrop",
      },
    });
    globalThis.fetch = vi.fn().mockResolvedValueOnce(geminiImageResponse()) as never;
    const getBalance = vi.fn().mockRejectedValue(new Error("should not call"));
    const { runPipeline } = await import("../src/pipeline.js");
    const result = await runPipeline(fakeTweet(), {
      env,
      store,
      connection: { getBalance } as unknown as Connection,
      wallet,
      // biome-ignore lint/suspicious/noExplicitAny: mocked
      llmModel: {} as any,
      blankClient: null,
      dryRun: true,
      force: true,
      backtest: true,
    });

    expect(result.decision).toBe("dry_run");
    expect(result.reason).toBe("backtest");
    expect(result.metadata?.symbol).toBe("DOGE");
    expect(result.image?.source).toBe("generated");
    expect(getBalance).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(blankCreateMock).not.toHaveBeenCalled();
    expect(store.recentSeen(10)[0]?.decision).toBe("dry_run");
  });

  it("backtest respects the classifier threshold by default", async () => {
    generateObjectMock.mockReset();
    generateObjectMock.mockResolvedValueOnce({
      object: classificationObject({
        shouldLaunch: false,
        confidence: 0.2,
        launchableMeme: false,
        memeSource: "none",
        disqualifiers: ["no_self_contained_joke"],
        reason: "weak signal",
      }),
    });
    globalThis.fetch = vi.fn() as never;
    const { runPipeline } = await import("../src/pipeline.js");
    const result = await runPipeline(fakeTweet(), {
      env,
      store,
      connection: fakeConnection(1),
      wallet,
      // biome-ignore lint/suspicious/noExplicitAny: mocked
      llmModel: {} as any,
      blankClient: null,
      dryRun: true,
      force: false,
      backtest: true,
    });

    expect(result.decision).toBe("skipped_low_score");
    expect(generateObjectMock).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("metadata generator throw is caught and recorded as skipped_error", async () => {
    generateObjectMock.mockReset();
    generateObjectMock.mockResolvedValueOnce({
      object: classificationObject(),
    });
    generateObjectMock.mockRejectedValueOnce(new Error("rate limit 429"));
    const { runPipeline } = await import("../src/pipeline.js");
    await runPipeline(fakeTweet(), {
      env,
      store,
      connection: fakeConnection(1),
      wallet,
      // biome-ignore lint/suspicious/noExplicitAny: mocked
      llmModel: {} as any,
      // biome-ignore lint/suspicious/noExplicitAny: mocked
      blankClient: { launch: { create: blankCreateMock } } as any,
      dryRun: false,
      force: false,
    });
    expect(store.recentLaunches(10)).toHaveLength(0);
    const seen = store.recentSeen(10);
    expect(seen[0]?.decision).toBe("skipped_error");
    expect(seen[0]?.reason).toMatch(/metadata/);
  });

  it("dedup short-circuits a re-seen tweet without --force", async () => {
    setupHappyMocks();
    const { runPipeline } = await import("../src/pipeline.js");
    const t = fakeTweet();
    await runPipeline(t, {
      env,
      store,
      connection: fakeConnection(1),
      wallet,
      // biome-ignore lint/suspicious/noExplicitAny: mocked
      llmModel: {} as any,
      // biome-ignore lint/suspicious/noExplicitAny: mocked
      blankClient: { launch: { create: blankCreateMock } } as any,
      dryRun: false,
      force: false,
    });
    expect(store.recentLaunches(10)).toHaveLength(1);
    // Second run: no new mocks queued; if pipeline ran, it would hit undefined fetch
    await runPipeline(t, {
      env,
      store,
      connection: fakeConnection(1),
      wallet,
      // biome-ignore lint/suspicious/noExplicitAny: mocked
      llmModel: {} as any,
      // biome-ignore lint/suspicious/noExplicitAny: mocked
      blankClient: { launch: { create: blankCreateMock } } as any,
      dryRun: false,
      force: false,
    });
    // Still only one launch; the second call returned at the dedup gate.
    expect(store.recentLaunches(10)).toHaveLength(1);
  });
});
