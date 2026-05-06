import type { google } from "@ai-sdk/google";
import type { Connection, Keypair } from "@solana/web3.js";
import { type Classification, classifyTweet, passesThreshold } from "./brain/classifier.js";
import { type PreparedImage, prepareImage, validateLaunchImage } from "./brain/image.js";
import { generateTokenMetadata, type Metadata } from "./brain/metadata.js";
import type { Env } from "./config.js";
import {
  type BlankClient,
  type LaunchCreateResult,
  launchToken,
  safeLaunchErrorMessage,
} from "./launcher/blank-launcher.js";
import {
  buildTokenMetadata,
  symbolForFilename,
  uploadImage,
  uploadMetadata,
  waitForMetadataAvailability,
} from "./launcher/pinata.js";
import { getLogger } from "./logger.js";
import { checkSafety, type SafetyDecision } from "./safety/safety.js";
import {
  hasAttachedVideo,
  isQuoteReactionOnly,
  type Tweet,
  tweetMediaType,
} from "./sources/tweet-source.js";
import type { Decision, Store } from "./store/db.js";
import { errMsg } from "./util/errors.js";
import { mimeToExt } from "./util/mime.js";
import { measureTxCostsSol } from "./util/tx-cost.js";

export type PipelineDeps = {
  env: Env;
  store: Store;
  connection: Connection;
  wallet: Keypair;
  llmModel: ReturnType<typeof google>;
  blankClient: BlankClient | null;
  dryRun: boolean;
  force: boolean;
  backtest?: boolean;
};

export type PipelineDecision = Decision | "duplicate";

export type PipelineResult = {
  tweetId: string;
  authorHandle: string;
  decision: PipelineDecision;
  reason: string;
  classification?: Classification;
  metadata?: Metadata;
  image?: {
    source: PreparedImage["source"];
    mimeType: string;
    bytes: number;
    width?: number;
    height?: number;
  };
  safety?: SafetyDecision;
  dryRun?: {
    metadataUri?: string;
    imageGateway?: string;
    metadataGateway?: string;
  };
};

export async function runPipeline(tweet: Tweet, deps: PipelineDeps): Promise<PipelineResult> {
  const log = getLogger({ tweet_id: tweet.id, author_handle: tweet.authorHandle });
  const seenAt = Date.now();
  const baseResult = { tweetId: tweet.id, authorHandle: tweet.authorHandle };
  const finish = (
    decision: PipelineDecision,
    reason: string,
    extra: Omit<Partial<PipelineResult>, "tweetId" | "authorHandle" | "decision" | "reason"> = {},
  ): PipelineResult => ({
    ...baseResult,
    decision,
    reason,
    ...extra,
  });
  const mediaType = tweetMediaType(tweet);
  const recordStage = (
    stage: string,
    status: "ok" | "skipped" | "blocked" | "error",
    startedAt: number,
    detail?: string,
  ): void => {
    deps.store.recordPipelineEvent({
      tweetId: tweet.id,
      authorHandle: tweet.authorHandle,
      stage,
      status,
      startedAt,
      finishedAt: Date.now(),
      ...(detail ? { detail } : {}),
    });
  };

  // Keep every terminal skip path writing the same tweets_seen shape.
  const skip = (
    decision: Decision,
    reason: string,
    classifier_score: number | null = null,
    extra: Omit<Partial<PipelineResult>, "tweetId" | "authorHandle" | "decision" | "reason"> = {},
  ): PipelineResult => {
    deps.store.recordSeen({
      tweet_id: tweet.id,
      author_handle: tweet.authorHandle,
      seen_at: seenAt,
      classifier_score,
      decision,
      reason,
      media_type: mediaType,
    });
    return finish(decision, reason, extra);
  };

  // Stage 0: dedup.
  if (deps.store.hasSeen(tweet.id)) {
    if (deps.force) {
      log.info("already seen, but --force overrides dedup");
    } else {
      log.info("already seen, skipping (use --force to re-process)");
      recordStage("dedup", "skipped", seenAt, "already_seen");
      return finish("duplicate", "already_seen");
    }
  }

  if (hasAttachedVideo(tweet)) {
    log.info("tweet has attached video media, skipping");
    recordStage("validation", "blocked", seenAt, "video_media_attached");
    return skip("skipped_validation", "video_media_attached");
  }

  if (isQuoteReactionOnly(tweet)) {
    log.info("quote tweet has reaction-only commentary, skipping");
    recordStage("validation", "blocked", seenAt, "quote_reaction_only");
    return skip("skipped_validation", "quote_reaction_only");
  }

  // Stage 1: classify.
  let classification: Classification;
  let stageStartedAt = Date.now();
  try {
    classification = await classifyTweet(tweet, {
      model: deps.llmModel,
      threshold: deps.env.CLASSIFIER_THRESHOLD,
    });
    recordStage("classify", "ok", stageStartedAt);
  } catch (err) {
    log.error({ err: errMsg(err) }, "classifier error");
    recordStage("classify", "error", stageStartedAt, errMsg(err));
    return skip("skipped_error", `classifier: ${errMsg(err)}`);
  }
  const score = classification.confidence;

  if (!passesThreshold(classification, deps.env.CLASSIFIER_THRESHOLD)) {
    if (deps.force) {
      log.info(
        { confidence: score, threshold: deps.env.CLASSIFIER_THRESHOLD },
        "below threshold, but --force overrides",
      );
    } else {
      recordStage("threshold", "blocked", Date.now(), classification.reason);
      return skip("skipped_low_score", classification.reason, score, { classification });
    }
  }

  // Stage 2: metadata generation. One validation retry is handled inside
  // generateTokenMetadata().
  let metadata: Metadata;
  stageStartedAt = Date.now();
  try {
    const metaResult = await generateTokenMetadata(tweet, {
      model: deps.llmModel,
      classification,
    });
    if (!metaResult.ok) {
      log.warn({ failure: metaResult.finalFailure }, "metadata validation failed twice");
      recordStage("metadata", "blocked", stageStartedAt, metaResult.finalFailure.reason);
      return skip(
        "skipped_validation",
        `${metaResult.finalFailure.field}: ${metaResult.finalFailure.reason}`,
        score,
        { classification },
      );
    }
    metadata = metaResult.metadata;
    recordStage("metadata", "ok", stageStartedAt);
  } catch (err) {
    log.error({ err: errMsg(err) }, "metadata generation threw");
    recordStage("metadata", "error", stageStartedAt, errMsg(err));
    return skip("skipped_error", `metadata: ${errMsg(err)}`, score, { classification });
  }

  // Stage 3: image.
  let image: PreparedImage;
  stageStartedAt = Date.now();
  try {
    image = await prepareImage(tweet, metadata, {
      apiKey: deps.env.GOOGLE_GENERATIVE_AI_API_KEY,
      model: deps.env.IMAGE_MODEL,
    });
    recordStage("image", "ok", stageStartedAt);
  } catch (err) {
    log.error({ err: errMsg(err) }, "image preparation failed");
    recordStage("image", "error", stageStartedAt, errMsg(err));
    return skip("skipped_error", `image: ${errMsg(err)}`, score, { classification, metadata });
  }
  const imageValidation = validateLaunchImage(image);
  if (!imageValidation.ok) {
    log.warn({ reason: imageValidation.reason }, "image validation failed");
    recordStage("image_validation", "blocked", Date.now(), imageValidation.reason);
    return skip("skipped_validation", `image_validation: ${imageValidation.reason}`, score, {
      classification,
      metadata,
    });
  }
  const imageSummary = {
    source: image.source,
    mimeType: imageValidation.mimeType,
    bytes: image.buffer.length,
    width: imageValidation.width,
    height: imageValidation.height,
  };

  if (deps.backtest) {
    log.info(
      {
        name: metadata.name,
        symbol: metadata.symbol,
        image_source: image.source,
        dry_run: true,
      },
      `BACKTEST: would launch ${metadata.name} ($${metadata.symbol}); skipping safety, IPFS, and blank.launch.create`,
    );
    return skip("dry_run", "backtest", score, {
      classification,
      metadata,
      image: imageSummary,
    });
  }

  // Stage 4: safety.
  // Caps (count + sol + per-launch), balance, RPC reach.
  const plannedSpend = deps.env.MAX_SOL_PER_LAUNCH;
  let safety: SafetyDecision;
  stageStartedAt = Date.now();
  try {
    safety = await checkSafety({
      env: deps.env,
      store: deps.store,
      connection: deps.connection,
      wallet: deps.wallet,
      plannedSpendSol: plannedSpend,
      now: Date.now(),
    });
    recordStage(
      "safety",
      safety.ok ? "ok" : "blocked",
      stageStartedAt,
      safety.ok ? undefined : safety.reason,
    );
  } catch (err) {
    log.error({ err: errMsg(err) }, "safety gate threw");
    recordStage("safety", "error", stageStartedAt, errMsg(err));
    return skip("skipped_error", `safety: ${errMsg(err)}`, score, {
      classification,
      metadata,
      image: imageSummary,
    });
  }
  if (!safety.ok) {
    log.info({ reason: safety.reason, detail: safety.detail }, "safety gate rejected");
    return skip("skipped_safety", `${safety.reason}: ${safety.detail}`, score, {
      classification,
      metadata,
      image: imageSummary,
      safety,
    });
  }

  // Stage 5: reserve daily-cap slot.
  // Atomic with the counter read; closes the TOCTOU window between
  // checkSafety and the launch insert. If the launch fails downstream,
  // we roll back the reservation.
  const reservation = deps.dryRun
    ? null
    : deps.store.reserveLaunchSlot({
        timestampMs: Date.now(),
        plannedSpendSol: plannedSpend,
        maxLaunchesPerDay: deps.env.MAX_LAUNCHES_PER_DAY,
        maxSolPerDay: deps.env.MAX_SOL_PER_DAY,
      });
  if (!deps.dryRun && !reservation) {
    const detail = `concurrent reservation lost the race against daily cap`;
    log.warn({ detail }, "reservation race lost");
    return skip("skipped_safety", `daily_cap_race: ${detail}`, score, {
      classification,
      metadata,
      image: imageSummary,
      safety,
    });
  }

  const rollbackIfReserved = () => {
    if (reservation) {
      try {
        deps.store.rollbackReservation({
          date: reservation.date,
          plannedSpendSol: reservation.plannedSpendSol,
        });
      } catch (err) {
        log.error({ err: errMsg(err) }, "rollbackReservation failed");
      }
    }
  };

  // Stage 6: IPFS uploads.
  let imageCid: string;
  let metadataCid: string;
  stageStartedAt = Date.now();
  try {
    const ext = mimeToExt(imageValidation.mimeType);
    imageCid = await uploadImage(
      image.buffer,
      `${symbolForFilename(metadata.symbol)}.${ext}`,
      imageValidation.mimeType,
      { jwt: deps.env.PINATA_JWT },
    );
    const tokenMetadata = buildTokenMetadata({
      name: metadata.name,
      symbol: metadata.symbol,
      imageCid,
      tweet: { id: tweet.id, authorHandle: tweet.authorHandle },
    });
    metadataCid = await uploadMetadata(tokenMetadata, { jwt: deps.env.PINATA_JWT });
    await waitForMetadataAvailability(metadataCid, tokenMetadata);
    recordStage("ipfs", "ok", stageStartedAt);
  } catch (err) {
    log.error({ err: errMsg(err) }, "IPFS upload failed");
    recordStage("ipfs", "error", stageStartedAt, errMsg(err));
    rollbackIfReserved();
    return skip("skipped_error", `ipfs: ${errMsg(err)}`, score, {
      classification,
      metadata,
      image: imageSummary,
      safety,
    });
  }

  const metadataUri = `ipfs://${metadataCid}`;

  // Stage 7: launch. Dry runs stop here after IPFS writes.
  if (deps.dryRun || !deps.blankClient) {
    recordStage("launch", "skipped", Date.now(), "dry-run");
    log.info(
      {
        metadata_uri: metadataUri,
        name: metadata.name,
        symbol: metadata.symbol,
        image_gateway: `https://gateway.pinata.cloud/ipfs/${imageCid}`,
        metadata_gateway: `https://gateway.pinata.cloud/ipfs/${metadataCid}`,
        dry_run: true,
      },
      `DRY RUN: would launch ${metadata.name} ($${metadata.symbol}); skipping blank.launch.create`,
    );
    return skip("dry_run", "dry-run", score, {
      classification,
      metadata,
      image: imageSummary,
      safety,
      dryRun: {
        metadataUri,
        imageGateway: `https://gateway.pinata.cloud/ipfs/${imageCid}`,
        metadataGateway: `https://gateway.pinata.cloud/ipfs/${metadataCid}`,
      },
    });
  }

  let result: LaunchCreateResult;
  stageStartedAt = Date.now();
  try {
    result = await launchToken({
      client: deps.blankClient,
      wallet: deps.wallet,
      tweet,
      metadata,
      metadataUri,
      stakingShareBps: deps.env.STAKING_SHARE_BPS,
    });
    recordStage("launch", "ok", stageStartedAt);
  } catch (err) {
    const safeMsg = safeLaunchErrorMessage(err);
    log.error({ err: safeMsg }, "blank.launch.create failed");
    recordStage("launch", "error", stageStartedAt, safeMsg);
    rollbackIfReserved();
    return skip("skipped_error", `launch: ${safeMsg}`, score, {
      classification,
      metadata,
      image: imageSummary,
      safety,
    });
  }

  // Stage 8: commit.
  // Atomic: launch row + tweets_seen, in one transaction. The counter was
  // already bumped by reserveLaunchSlot.
  const launchedAt = Date.now();
  const txSignature = result.submission.signature;
  // Measure the actual on-chain cost (network fee + program fees + rent)
  // from the wallet's pre/post balance delta across every submitted launch
  // transaction, then reconcile the reserved cap to this exact value.
  stageStartedAt = Date.now();
  let actualSolSpent: number;
  try {
    actualSolSpent = await measureTxCostsSol({
      connection: deps.connection,
      signatures: [txSignature, ...result.submission.signatures],
      payer: deps.wallet.publicKey,
    });
    recordStage("tx_cost", "ok", stageStartedAt);
  } catch (err) {
    log.error({ err: errMsg(err) }, "transaction cost measurement failed");
    recordStage("tx_cost", "error", stageStartedAt, errMsg(err));
    actualSolSpent = plannedSpend;
  }
  if (!reservation) {
    throw new Error("live launch reached commit without a reservation");
  }
  deps.store.commitReservedLaunch(
    {
      mint: result.mintAddress,
      ticker: metadata.symbol,
      name: metadata.name,
      source_tweet_id: tweet.id,
      source_author: tweet.authorHandle,
      sol_spent: actualSolSpent,
      tx_signature: txSignature,
      metadata_uri: metadataUri,
      image_cid: imageCid,
      launched_at: launchedAt,
      classification_reason: classification.reason,
    },
    {
      tweet_id: tweet.id,
      author_handle: tweet.authorHandle,
      seen_at: seenAt,
      classifier_score: score,
      decision: "launched",
      reason: classification.reason,
      media_type: mediaType,
    },
    reservation,
  );
  log.info(
    { mint: result.mintAddress, tx: txSignature, launch_id: result.launchId },
    "launch complete",
  );
  return finish("launched", classification.reason, {
    classification,
    metadata,
    image: imageSummary,
    safety,
  });
}
