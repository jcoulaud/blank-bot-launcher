import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";
import { getLogger } from "../logger.js";
import type { Tweet } from "../sources/tweet-source.js";
import { buildMetadataPrompt, isReservedSymbol, PROMPT_VERSION } from "./prompts.js";

export const MetadataSchema = z.object({
  name: z.string().min(1).max(64),
  symbol: z.string().min(1).max(20),
  imageStrategy: z.enum(["reuse", "remix", "generate"]),
  imagePrompt: z.string().optional(),
  remixInstructions: z.string().optional(),
});

export type Metadata = z.infer<typeof MetadataSchema>;

export type MetadataOptions = {
  model: LanguageModel;
};

const NAME_MAX_BYTES = 32;
const SYMBOL_MAX_BYTES = 10;
const SYMBOL_PATTERN = /^[A-Z0-9]+$/;

export type ValidationFailure = {
  field: keyof Metadata | "imageStrategy_consistency";
  reason: string;
};

export function validateMetadata(meta: Metadata, tweet: Tweet): ValidationFailure | null {
  const nameNormalized = meta.name.normalize("NFKC");
  if (Buffer.byteLength(nameNormalized, "utf8") > NAME_MAX_BYTES) {
    return {
      field: "name",
      reason: `name "${nameNormalized}" exceeds ${NAME_MAX_BYTES} bytes after NFKC normalization`,
    };
  }

  const symbol = meta.symbol.toUpperCase();
  if (Buffer.byteLength(symbol, "utf8") > SYMBOL_MAX_BYTES) {
    return { field: "symbol", reason: `symbol "${symbol}" exceeds ${SYMBOL_MAX_BYTES} bytes` };
  }
  if (!SYMBOL_PATTERN.test(symbol)) {
    return {
      field: "symbol",
      reason: `symbol "${symbol}" must match /^[A-Z0-9]+$/ (no spaces, no lowercase, no special chars)`,
    };
  }
  if (isReservedSymbol(symbol)) {
    return { field: "symbol", reason: `symbol "${symbol}" is reserved (SOL/USDC/BLNK)` };
  }

  if (meta.imageStrategy === "generate" && !meta.imagePrompt) {
    return {
      field: "imageStrategy_consistency",
      reason: `imageStrategy="generate" but imagePrompt is missing`,
    };
  }
  if (meta.imageStrategy === "remix") {
    if (!meta.remixInstructions) {
      return {
        field: "imageStrategy_consistency",
        reason: `imageStrategy="remix" but remixInstructions is missing`,
      };
    }
    if (!tweet.images[0]) {
      return {
        field: "imageStrategy_consistency",
        reason: `imageStrategy="remix" but the tweet has no image to remix`,
      };
    }
  }
  if (meta.imageStrategy === "reuse" && !tweet.images[0]) {
    return {
      field: "imageStrategy_consistency",
      reason: `imageStrategy="reuse" but the tweet has no image to reuse`,
    };
  }

  return null;
}

export type GenerateMetadataResult =
  | { ok: true; metadata: Metadata; attempts: number }
  | { ok: false; finalFailure: ValidationFailure; attempts: number };

/**
 * Stage 2 — generate token metadata with single-retry recovery (per D3).
 * On validation failure, re-call the LLM once with a corrective hint.
 * If second attempt also fails, return failure (caller drops the tweet).
 */
export async function generateTokenMetadata(
  tweet: Tweet,
  options: MetadataOptions,
): Promise<GenerateMetadataResult> {
  const log = getLogger({
    tweet_id: tweet.id,
    author_handle: tweet.authorHandle,
    pipeline_stage: "metadata",
  });

  let lastFailure: ValidationFailure | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt = buildMetadataPrompt({
      tweet,
      ...(lastFailure ? { previousFailureHint: lastFailure.reason } : {}),
    });
    const start = Date.now();
    const result = await generateObject({
      model: options.model,
      schema: MetadataSchema,
      prompt,
    });
    const meta = result.object;
    // Normalize symbol to uppercase before validation (LLM may return lowercase)
    meta.symbol = meta.symbol.toUpperCase();
    meta.name = meta.name.normalize("NFKC");

    const failure = validateMetadata(meta, tweet);
    log.info(
      {
        attempt,
        prompt_version: PROMPT_VERSION,
        duration_ms: Date.now() - start,
        name: meta.name,
        symbol: meta.symbol,
        strategy: meta.imageStrategy,
        validation_pass: failure === null,
      },
      failure === null ? `generated: ${meta.name} ($${meta.symbol})` : "metadata attempt failed",
    );

    if (failure === null) {
      return { ok: true, metadata: meta, attempts: attempt };
    }
    lastFailure = failure;
  }

  if (!lastFailure) {
    throw new Error("unreachable: loop exited without setting lastFailure");
  }
  return { ok: false, finalFailure: lastFailure, attempts: 2 };
}
