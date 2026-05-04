import {
  type BlankClient,
  createBlankClient,
  createBlankKeypairWallet,
  type LaunchCreateInput,
  type LaunchCreateResult,
} from "@blankdotbuild/sdk";
import type { Keypair } from "@solana/web3.js";
import type { Metadata } from "../brain/metadata.js";
import { getLogger } from "../logger.js";
import type { Tweet } from "../sources/tweet-source.js";

export type { BlankClient, LaunchCreateResult };

export type BlankClientConfig = {
  baseUrl: string;
  apiKey: string;
};

export function buildBlankClient(config: BlankClientConfig): BlankClient {
  return createBlankClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
  });
}

export type LaunchContext = {
  client: BlankClient;
  wallet: Keypair;
  tweet: Tweet;
  metadata: Metadata;
  metadataUri: string;
};

export async function launchToken(ctx: LaunchContext): Promise<LaunchCreateResult> {
  const log = getLogger({
    tweet_id: ctx.tweet.id,
    author_handle: ctx.tweet.authorHandle,
    pipeline_stage: "launch",
  });

  const input: LaunchCreateInput = {
    name: ctx.metadata.name,
    symbol: ctx.metadata.symbol,
    metadataUri: ctx.metadataUri,
    antiSnipeEnabled: true,
    idempotencyKey: `blank-bot-${ctx.tweet.id}`,
  };

  const blankWallet = createBlankKeypairWallet(ctx.wallet);

  log.info(
    { symbol: input.symbol, metadata_uri: input.metadataUri },
    "calling blank.launch.create",
  );
  const start = Date.now();
  try {
    const result = await ctx.client.launch.create(input, blankWallet);
    log.info(
      {
        mint: result.mintAddress,
        launch_id: result.launchId,
        signature: result.submission.signature,
        transport: result.submission.kind,
        duration_ms: Date.now() - start,
      },
      "launch succeeded",
    );
    return result;
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), duration_ms: Date.now() - start },
      "launch failed",
    );
    throw err;
  }
}
