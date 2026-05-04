import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";
import { getLogger } from "../logger.js";
import type { Tweet } from "../sources/tweet-source.js";
import { ZERO_WIDTH_AND_BIDI_RE } from "../util/text.js";
import { buildMetadataPrompt, type ClassificationContext, isReservedSymbol } from "./prompts.js";

export const MetadataSchema = z.object({
  name: z.string().min(1).max(64),
  symbol: z.string().min(1).max(20),
  imageStrategy: z.enum(["reuse", "remix", "generate"]),
  imageStyle: z
    .enum([
      "classic-meme-poster",
      "reaction-image",
      "surreal-internet-collage",
      "clean-vector-mascot",
      "fake-screenshot",
      "retro-comic-panel",
    ])
    .optional(),
  imagePrompt: z.string().optional(),
  remixInstructions: z.string().optional(),
});

export type Metadata = z.infer<typeof MetadataSchema>;
export type ImageStyle = NonNullable<Metadata["imageStyle"]>;
export type { ClassificationContext };

export type MetadataOptions = {
  model: LanguageModel;
  classification: ClassificationContext;
  /** Max attempts before failing. Default 2 (one retry). */
  maxAttempts?: number;
};

const NAME_MAX_BYTES = 32;
const SYMBOL_MAX_BYTES = 10;
const SYMBOL_PATTERN = /^[A-Z0-9]+$/;
const NAME_PRONOUN_FILLERS = new Set([
  "i",
  "me",
  "my",
  "we",
  "us",
  "our",
  "your",
  "his",
  "her",
  "its",
  "their",
]);
const NAME_LOW_SIGNAL_FILLERS = new Set([
  "and",
  "just",
  "like",
  "that",
  "this",
  "now",
  "am",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
]);
const NAME_CONNECTIVE_FILLERS = new Set([
  "a",
  "an",
  "the",
  "of",
  "in",
  "on",
  "at",
  "to",
  "for",
  "with",
  "from",
  "by",
]);
const SYMBOL_FILLERS = new Set([
  ...NAME_PRONOUN_FILLERS,
  ...NAME_LOW_SIGNAL_FILLERS,
  ...NAME_CONNECTIVE_FILLERS,
]);

export type ValidationFailure = {
  field: keyof Metadata | "imageStrategy_consistency";
  reason: string;
};

function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

function compactMetadataText(s: string): string {
  return s.normalize("NFKC").replace(ZERO_WIDTH_AND_BIDI_RE, "").replace(/\s+/g, " ").trim();
}

function normalizeWordForMatching(word: string): string {
  return word.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
}

function withoutFillerWords(input: string, fillers: ReadonlySet<string>): string {
  let words = input.split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length && utf8Bytes(words.join(" ")) > NAME_MAX_BYTES; i++) {
    const word = words[i];
    if (!word || !fillers.has(normalizeWordForMatching(word)) || words.length <= 1) continue;
    words = words.filter((_, index) => index !== i);
    i--;
  }
  return words.join(" ");
}

function bestContiguousNameWindow(input: string): string | null {
  const words = input.split(/\s+/).filter(Boolean);
  let best = "";
  let bestScore = Number.NEGATIVE_INFINITY;

  for (let start = 0; start < words.length; start++) {
    for (let end = start + 1; end <= words.length; end++) {
      const window = words.slice(start, end);
      const candidate = window.join(" ");
      const bytes = utf8Bytes(candidate);
      if (bytes > NAME_MAX_BYTES) continue;

      const first = window[0];
      const last = window[window.length - 1];
      if (!first || !last) continue;

      const edgePenalty =
        (SYMBOL_FILLERS.has(normalizeWordForMatching(first)) ? 6 : 0) +
        (SYMBOL_FILLERS.has(normalizeWordForMatching(last)) ? 6 : 0);
      const suffixBonus = end === words.length ? 3 : 0;
      const score = bytes - edgePenalty + suffixBonus;
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
  }

  return best || null;
}

function truncateToUtf8Bytes(input: string, maxBytes: number): string {
  let out = "";
  for (const char of input) {
    const next = out + char;
    if (utf8Bytes(next) > maxBytes) break;
    out = next;
  }
  return out.replace(/[\s\p{P}]+$/u, "").trim();
}

function fitNameToLimit(name: string): string {
  let candidate = compactMetadataText(name);
  if (utf8Bytes(candidate) <= NAME_MAX_BYTES) return candidate;

  for (const fillers of [NAME_PRONOUN_FILLERS, NAME_LOW_SIGNAL_FILLERS, NAME_CONNECTIVE_FILLERS]) {
    candidate = withoutFillerWords(candidate, fillers);
    if (utf8Bytes(candidate) <= NAME_MAX_BYTES) return candidate;
  }

  return bestContiguousNameWindow(candidate) ?? truncateToUtf8Bytes(candidate, NAME_MAX_BYTES);
}

function isValidSymbolCandidate(symbol: string): boolean {
  return (
    symbol.length > 0 &&
    utf8Bytes(symbol) <= SYMBOL_MAX_BYTES &&
    SYMBOL_PATTERN.test(symbol) &&
    !isReservedSymbol(symbol)
  );
}

function symbolCandidatesFromName(name: string): string[] {
  const words = name.toUpperCase().match(/[A-Z0-9]+/g) ?? [];
  return words
    .filter((word) => !SYMBOL_FILLERS.has(word.toLowerCase()))
    .filter((word) => utf8Bytes(word) <= SYMBOL_MAX_BYTES)
    .reverse();
}

function repairSymbol(symbol: string, name: string): string {
  const compact = symbol
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (isValidSymbolCandidate(compact)) return compact;

  // Pass the reserved symbol through unchanged so validateMetadata fails
  // and the metadata generator retries with the failure hint. Repairing it
  // here would silently swap the model's choice.
  if (compact && isReservedSymbol(compact)) return compact;

  for (const candidate of symbolCandidatesFromName(name)) {
    if (isValidSymbolCandidate(candidate)) return candidate;
  }

  return truncateToUtf8Bytes(compact, SYMBOL_MAX_BYTES);
}

export function repairMetadata(meta: Metadata): Metadata {
  const name = fitNameToLimit(meta.name);
  return {
    ...meta,
    name,
    symbol: repairSymbol(meta.symbol, name),
  };
}

export function validateMetadata(meta: Metadata, tweet: Tweet): ValidationFailure | null {
  const nameNormalized = compactMetadataText(meta.name);
  if (nameNormalized.length === 0) {
    return {
      field: "name",
      reason: "name is empty after NFKC normalization",
    };
  }
  if (utf8Bytes(nameNormalized) > NAME_MAX_BYTES) {
    return {
      field: "name",
      reason: `name "${nameNormalized}" exceeds ${NAME_MAX_BYTES} bytes after NFKC normalization`,
    };
  }

  const symbol = meta.symbol.toUpperCase();
  if (utf8Bytes(symbol) > SYMBOL_MAX_BYTES) {
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
  if (meta.imageStrategy === "generate" && !meta.imageStyle) {
    return {
      field: "imageStyle",
      reason: `imageStrategy="generate" but imageStyle is missing`,
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

export async function generateTokenMetadata(
  tweet: Tweet,
  options: MetadataOptions,
): Promise<GenerateMetadataResult> {
  const log = getLogger({
    tweet_id: tweet.id,
    author_handle: tweet.authorHandle,
    pipeline_stage: "metadata",
  });

  const maxAttempts = options.maxAttempts ?? 2;
  let lastFailure: ValidationFailure | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const prompt = buildMetadataPrompt({
      tweet,
      classification: options.classification,
      ...(lastFailure ? { previousFailureHint: lastFailure.reason } : {}),
    });
    const start = Date.now();
    const result = await generateObject({
      model: options.model,
      schema: MetadataSchema,
      prompt,
    });
    const meta = repairMetadata(result.object);

    const failure = validateMetadata(meta, tweet);
    log.info(
      {
        attempt,
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
  return { ok: false, finalFailure: lastFailure, attempts: maxAttempts };
}
