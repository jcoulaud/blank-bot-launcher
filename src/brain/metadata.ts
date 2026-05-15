import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";
import { getLogger } from "../logger.js";
import { getPrimaryLaunchImage, type Tweet } from "../sources/tweet-source.js";
import { ZERO_WIDTH_AND_BIDI_RE } from "../util/text.js";
import { buildMetadataPrompt, type ClassificationContext, isReservedSymbol } from "./prompts.js";

export const IMAGE_STYLES = [
  "meme-character",
  "reaction-face",
  "graphic-emblem",
  "object-icon",
  "studio-photo",
  "surreal-icon",
  "pixel-icon",
  "3d-avatar",
  "photo-collage",
] as const;

export const MetadataSchema = z.object({
  name: z.string().min(1).max(64),
  symbol: z.string().min(1).max(20),
  imageStrategy: z.enum(["reuse", "remix", "generate"]),
  imageStyle: z.enum(IMAGE_STYLES).optional(),
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
const HIGH_SIGNAL_INITIALISMS = new Set([
  "AGI",
  "AI",
  "API",
  "CPU",
  "CTO",
  "DAO",
  "ETF",
  "GPU",
  "IPO",
  "IQ",
  "LLM",
  "NFT",
  "NPC",
  "UFO",
  "ZK",
]);
const BLOCKED_GENERIC_IMAGE_PROMPT_PATTERNS = [
  /\bcartoon meme illustration\b/i,
  /\bbold colors?\b.*\bsimple shapes?\b/i,
  /^\s*(doge|pepe|wojak|chad|meme|token|coin|logo|icon)\s*$/i,
  // Anti-literal-symbolism: anchors that are just a direct icon of the words read as AI slop.
  // The anchor must be a specific cultural artifact, not a generic symbolic visualization.
  /Anchor\s*:[^.]*\bcrossed[-\s]?out\b/i,
  /Anchor\s*:[^.]*\b(?:simple|generic|basic|minimalist|clean|abstract)\s+(?:sticker|illustration|icon|emblem|design|symbol|graphic|logo|mark|art)\b/i,
  /Anchor\s*:[^.]*\bprotest\s+sticker\b/i,
  /Anchor\s*:[^.]*\bconcept\s+(?:art|illustration|piece)\b/i,
] as const;
const AI_MODEL_AUTHOR_HANDLES = new Set(["sama", "openai", "gdb"]);
const AI_MODEL_NAMING_WORD_RE = /\b(name|named|naming|call|called)\b/i;
const AI_MODEL_SUBJECT_RE = /\b(model|models|gpt|llm)\b/i;
const AI_BRAND_ANCHOR_RE = /\b(chatgpt|openai|gpt|llm|knot|brand|emblem|logo)\b/i;
const PROMPT_SHAPE_RE = /\bAnchor\s*:.+\bTwist\s*:/is;
const CRYPTO_CONTEXT_RE =
  /\b(solana|validator|validators|genesis\s+node|node|nodes|cluster|bootstrap|alpenglow|mainnet|devnet|testnet|staking|stake|stakepool|pool|dex|raydium|jupiter|jito|token|mint|airdrop|wallet|ledger|on-?chain|blockchain|defi|nft|dao|pump\.?\s*fun|memecoin|crypto)\b/i;
const CRYPTO_VISUAL_CUE_RE =
  /\b(solana|validator|validators|genesis\s+node|node|nodes|cluster|bootstrap|alpenglow|mainnet|devnet|testnet|staking|stake|stakepool|pool|server|rack|hardware|datacenter|ledger|wallet|block|on-?chain|chain|dex|raydium|jupiter|jito|pump\.?\s*fun|crypto\s+twitter|ct|degen|memecoin|bonk|bome|slerf|mew|candle|candles)\b/i;
const MEME_CULTURE_ANCHOR_RE =
  /\b(wojak|feels[-\s]?guy|brainlet|doomer|bloomer|zoomer|boomer|soyjak|npc|chad|giga\s?chad|yes[-\s]?chad|nordic[-\s]?gamer|apu|pepe|doge|4chan|reddit|matrix|morpheus|sopranos|lotr|lord\s+of\s+the\s+rings|star\s+wars|anakin|akira|gta|office\s+space|breaking\s+bad|dune|interstellar|pulp\s+fiction|renaissance|greek\s+statue|classical\s+art|caravaggio|vermeer|hokusai|casio|tamagotchi|nokia|clippy|pit\s+viper|pit\s+vipers|blackberry|razr|stanley\s+cup|ikea\s+bag|pokemon\s+card|magic\s+the\s+gathering|mtg\s+card|yu-?gi-?oh|topps|garbage\s+pail\s+kids|allen\s+(?:and|&)\s+ginter|baseball\s+card|trading\s+card|tcg|silver[-\s]?age|ec\s+comics|lichtenstein|tintin|action\s+comics|comic[-\s]?cover|sports\s+illustrated|si\s+cover|championship\s+trophy|jersey|national\s+enquirer|tabloid|time\s+magazine|people\s+(?:cover|magazine)|chyron|joy\s+division|unknown\s+pleasures|velvet\s+underground|nevermind|dark\s+side\s+of\s+the\s+moon|abbey\s+road|album\s+art|festival\s+poster|mixtape|zine\s+cover|phrygian|liberty\s+cap|sans-?culottes?|tricolor|cockade|guillotine|boston\s+tea\s+party|washington|we\s+the\s+people|statue\s+of\s+liberty|don'?t\s+tread\s+on\s+me|gadsden|protest\s+sign|cardboard\s+sign|anonymous\s+mask|guy\s+fawkes|banksy|they\s+live|altarpiece|chalkboard|textbook\s+diagram)\b/i;

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

function normalizeImagePromptForSpecificity(s: string): string {
  return compactMetadataText(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isGenericGeneratedImagePrompt(prompt: string, name: string): boolean {
  if (BLOCKED_GENERIC_IMAGE_PROMPT_PATTERNS.some((pattern) => pattern.test(prompt))) return true;

  const normalizedPrompt = normalizeImagePromptForSpecificity(prompt);
  if (!normalizedPrompt) return true;

  const normalizedName = normalizeImagePromptForSpecificity(name);
  if (normalizedPrompt === normalizedName) return true;

  const meaningfulWords = normalizedPrompt
    .split(" ")
    .filter((word) => word.length > 2 && !SYMBOL_FILLERS.has(word));
  return meaningfulWords.length < 3;
}

function isAiModelNamingTweet(tweet: Tweet): boolean {
  const handle = tweet.authorHandle.toLowerCase();
  if (!AI_MODEL_AUTHOR_HANDLES.has(handle)) return false;

  const text = compactMetadataText(`${tweet.text} ${tweet.quotedTweet?.text ?? ""}`);
  return AI_MODEL_NAMING_WORD_RE.test(text) && AI_MODEL_SUBJECT_RE.test(text);
}

function tweetHasExplicitCryptoContext(tweet: Tweet): boolean {
  return CRYPTO_CONTEXT_RE.test(`${tweet.text} ${tweet.quotedTweet?.text ?? ""}`);
}

function quotedModelNameCandidate(tweet: Tweet): string | null {
  const text = `${tweet.text} ${tweet.quotedTweet?.text ?? ""}`;
  const patterns = [
    /["“]([A-Za-z][A-Za-z0-9 -]{0,20})["”]/,
    /[‘]([A-Za-z][A-Za-z0-9 -]{0,20})[’]/,
    /(?:^|\s)'([A-Za-z][A-Za-z0-9 -]{0,20})'(?:\s|$|[.,!?])/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const candidate = match?.[1]?.trim();
    if (candidate) return candidate;
  }
  return null;
}

function normalizeTokenishText(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
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

function highSignalInitialismFromName(name: string): string | null {
  const words = name.toUpperCase().match(/[A-Z0-9]+/g) ?? [];
  const meaningfulWords = words.filter((word) => !SYMBOL_FILLERS.has(word.toLowerCase()));
  if (meaningfulWords.length < 2 || meaningfulWords.length > 5) return null;

  const initialism = meaningfulWords.map((word) => word.charAt(0)).join("");
  if (!isValidSymbolCandidate(initialism)) return null;
  return HIGH_SIGNAL_INITIALISMS.has(initialism) ? initialism : null;
}

function repairSymbol(symbol: string, name: string): string {
  const compact = symbol
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  const highSignalInitialism = highSignalInitialismFromName(name);
  if (highSignalInitialism) return highSignalInitialism;

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

  if (isAiModelNamingTweet(tweet)) {
    const modelNameCandidate = quotedModelNameCandidate(tweet);
    if (modelNameCandidate) {
      const expectedNameToken = `${normalizeTokenishText(modelNameCandidate)}gpt`;
      const actualNameToken = normalizeTokenishText(nameNormalized);
      if (!actualNameToken.includes(expectedNameToken)) {
        return {
          field: "name",
          reason: `AI model naming tweets should coin the product-context name "${modelNameCandidate}GPT" rather than a literal phrase`,
        };
      }
    }

    if (!symbol.includes("GPT")) {
      return {
        field: "symbol",
        reason:
          "AI model naming tweets from AI/product figures should use a GPT/product-context ticker",
      };
    }
  }

  if (meta.imageStrategy === "generate") {
    if (!meta.imagePrompt) {
      return {
        field: "imageStrategy_consistency",
        reason: `imageStrategy="generate" but imagePrompt is missing`,
      };
    }
    if (!PROMPT_SHAPE_RE.test(meta.imagePrompt)) {
      return {
        field: "imagePrompt",
        reason:
          'imagePrompt must use the exact shape "Anchor: <recognizable anchor>. Twist: <tweet-specific change>."',
      };
    }
    if (isGenericGeneratedImagePrompt(meta.imagePrompt, meta.name)) {
      return {
        field: "imagePrompt",
        reason:
          "imagePrompt is too generic; provide a tweet-specific subject, visual gag, rendering treatment, and simple background",
      };
    }
    const hasCryptoContext = tweetHasExplicitCryptoContext(tweet);
    if (hasCryptoContext && !CRYPTO_VISUAL_CUE_RE.test(meta.imagePrompt)) {
      return {
        field: "imagePrompt",
        reason:
          "tweet/quoted context is crypto-native; generated imagePrompt must include a visible crypto-native cue from that context (for example validator node, cluster/bootstrap, Solana/pump.fun/CT motif) instead of a standalone literal subject",
      };
    }
    if (hasCryptoContext && !MEME_CULTURE_ANCHOR_RE.test(meta.imagePrompt)) {
      return {
        field: "imagePrompt",
        reason:
          "tweet/quoted context is crypto-native; generated imagePrompt must use a strong meme or pop-culture anchor (for example Wojak/Brainlet/Soyjak/Pepe/Doge, a known movie scene, classical art, or retro internet object). Technical crypto props alone are not enough.",
      };
    }
    if (isAiModelNamingTweet(tweet) && !AI_BRAND_ANCHOR_RE.test(meta.imagePrompt)) {
      return {
        field: "imagePrompt",
        reason:
          "AI model naming tweets need an AI-brand/product anchor (ChatGPT/OpenAI/GPT/knot/emblem), not a literal creature or object only",
      };
    }
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
    if (!getPrimaryLaunchImage(tweet)) {
      return {
        field: "imageStrategy_consistency",
        reason: `imageStrategy="remix" but the tweet has no image to remix`,
      };
    }
  }
  if (meta.imageStrategy === "reuse" && !getPrimaryLaunchImage(tweet)) {
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
    const primaryImage = getPrimaryLaunchImage(tweet);
    const messages: Parameters<typeof generateObject>[0]["messages"] = [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          ...(primaryImage ? [{ type: "image" as const, image: new URL(primaryImage.url) }] : []),
        ],
      },
    ];
    const start = Date.now();
    const result = await generateObject({
      model: options.model,
      schema: MetadataSchema,
      messages,
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
