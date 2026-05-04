import {
  type BlankClient,
  BlankSdkError,
  createBlankClient,
  createBlankKeypairWallet,
  type LaunchCreateInput,
  type LaunchCreateResult,
  LaunchSubmissionFailedError,
} from "@blankdotbuild/sdk";
import type { Keypair } from "@solana/web3.js";
import type { Metadata } from "../brain/metadata.js";
import { getLogger } from "../logger.js";
import type { Tweet } from "../sources/tweet-source.js";
import { errMsg } from "../util/errors.js";

export type { BlankClient, LaunchCreateResult };
export { LaunchSubmissionFailedError };

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
  stakingShareBps: number;
};

/**
 * Returns a log/notification-safe string for any launch error.
 * Never includes `signedTransactions` from
 * `LaunchSubmissionFailedError`; those are valid signed Solana
 * transactions that anyone can broadcast against your wallet.
 */
export function safeLaunchErrorMessage(err: unknown): string {
  if (err instanceof LaunchSubmissionFailedError) {
    return `LaunchSubmissionFailedError launchId=${err.launchId} mint=${err.mintAddress} intent=${err.submissionIntentId} (signedTransactions redacted)`;
  }
  if (err instanceof BlankSdkError) {
    const parts = [err.message];
    if (err.code) parts.push(`code=${err.code}`);
    if (err.status) parts.push(`status=${err.status}`);
    const attempts = extractMetadataAttempts(err.details);
    if (attempts) parts.push(`attempts=${attempts}`);
    return parts.join(" ");
  }
  return errMsg(err);
}

function extractMetadataAttempts(details: unknown): string | null {
  if (details == null || typeof details !== "object") return null;
  const attempts = (details as { attempts?: unknown }).attempts;
  if (!Array.isArray(attempts) || attempts.length === 0) return null;
  return attempts
    .map((attempt) => {
      if (attempt == null || typeof attempt !== "object") return null;
      const row = attempt as {
        host?: unknown;
        reason?: unknown;
        status?: unknown;
      };
      const host = typeof row.host === "string" ? row.host : "<unknown>";
      const reason = typeof row.reason === "string" ? row.reason : "unknown";
      const status = typeof row.status === "number" ? row.status : "n/a";
      return `${host}:${reason}:${status}`;
    })
    .filter(Boolean)
    .join(",");
}

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
    antiSnipeEnabled: false,
    staking: { shareBps: ctx.stakingShareBps },
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
      { err: safeLaunchErrorMessage(err), duration_ms: Date.now() - start },
      "launch failed",
    );
    throw err;
  }
}
