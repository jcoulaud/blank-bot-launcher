import type { Tweet } from "../sources/tweet-source.js";

/* PROMPT_VERSION: 2
 *
 * Prompts live as typed functions (not raw strings) so they can be unit-tested,
 * version-correlated to outputs in SQLite, and tuned without breaking the schema.
 * Bump PROMPT_VERSION whenever the wording changes. The version gets logged with
 * every LLM call so prompt-quality regressions can be tracked over time.
 *
 * v2: dropped `description` field (the source tweet IS the description for a
 *     tweet-grounded memecoin; carried in metadata.json's external_url + properties.tweet).
 */
export const PROMPT_VERSION = 2;

const RESERVED_SYMBOLS = ["SOL", "USDC", "BLNK"] as const;

const CLASSIFIER_FEW_SHOT = `
Examples:

Tweet: "doge to the moon" — author: elonmusk
→ shouldLaunch=true, confidence=0.92, reason="iconic doge reference, clear meme vector"

Tweet: "Excited to announce our Series C" — author: sama
→ shouldLaunch=false, confidence=0.15, reason="corporate fundraising news, no meme energy"

Tweet: "thinking about chickens" — author: VitalikButerin
→ shouldLaunch=true, confidence=0.86, reason="absurdist Vitalik energy, easily memeable"

Tweet: "Q3 earnings call at 5pm" — author: anyone
→ shouldLaunch=false, confidence=0.05, reason="boilerplate corporate communication"

Tweet: "we live in a simulation" with attached AI-generated image — author: elonmusk
→ shouldLaunch=true, confidence=0.88, reason="philosophical meme + visual asset, strong meme template"
`.trim();

const METADATA_FEW_SHOT = `
Examples:

Tweet: "doge to the moon" — author: elonmusk, no image
→ name="Elon Doge to the Moon", symbol="EDOGE",
  imageStrategy="generate", imagePrompt="cartoon doge in astronaut suit holding a SpaceX rocket, bold colors, meme style"

Tweet: "thinking about chickens" — author: VitalikButerin, with photo of a chicken
→ name="Vitalik's Chicken", symbol="CLUCK",
  imageStrategy="reuse"  (no imagePrompt or remixInstructions needed)

Tweet: "the future is now" — author: sama, with screenshot of a chart
→ name="Future Now", symbol="FNOW",
  imageStrategy="remix", remixInstructions="cartoonify, add bold neon outline, reduce chart noise"
`.trim();

export function buildClassifierPrompt(tweet: Tweet): string {
  return `You are a memecoin opportunity classifier for an autonomous Solana token-launch bot.

Decide whether this tweet is "memeable enough" to justify launching a token. Be strict: most tweets are not memeable. We only launch tokens for tweets with strong meme potential — culturally resonant phrasing, iconic references, absurdism, or strong visual hooks. Boring corporate news, replies, regular updates, and anything generic should be rejected with low confidence.

Output a confidence score 0–1. Only tweets above 0.85 will actually launch.

${CLASSIFIER_FEW_SHOT}

Now classify:
Tweet text: ${tweet.text}
Author: ${tweet.authorHandle}
Has image: ${tweet.images.length > 0 ? "yes" : "no"}
Is quote tweet: ${tweet.isQuoteTweet}
${tweet.quotedTweet ? `Quoted text: ${tweet.quotedTweet.text}` : ""}
`.trim();
}

export type MetadataPromptInput = {
  tweet: Tweet;
  previousFailureHint?: string;
};

export function buildMetadataPrompt({ tweet, previousFailureHint }: MetadataPromptInput): string {
  const reservedList = RESERVED_SYMBOLS.join(", ");
  const hint = previousFailureHint
    ? `\n\nIMPORTANT: previous attempt failed validation: ${previousFailureHint}\nFix this in your next attempt.`
    : "";

  return `You are generating Solana token metadata from a tweet for an autonomous memecoin launcher.

Constraints (these are HARD — code validates them after you respond):
- name: ≤32 bytes after NFKC normalization, no zero-width or RTL characters. The name is what people will see — make it punchy, memorable, and clearly inspired by the tweet.
- symbol: uppercase A-Z and 0-9 only, ≤10 bytes, no spaces, NOT one of: ${reservedList}. Treat the symbol as a ticker — short, pronounceable, vibing with the meme.
- imageStrategy: one of "reuse", "remix", "generate"
  - "reuse" if the tweet already has an image and it's meme-worthy as-is — use this when possible
  - "remix" if the tweet has an image that needs stylistic improvement — provide remixInstructions
  - "generate" if there's no image, or the image is unusable — provide imagePrompt
- imagePrompt: required iff imageStrategy="generate"
- remixInstructions: required iff imageStrategy="remix"

DO NOT generate a description — the source tweet itself is the description, and it will be embedded in the on-chain metadata automatically.

${METADATA_FEW_SHOT}

Now generate metadata:
Tweet text: ${tweet.text}
Author: ${tweet.authorHandle}
Has image: ${tweet.images.length > 0 ? "yes" : "no"}${hint}
`.trim();
}

export function isReservedSymbol(symbol: string): boolean {
  return (RESERVED_SYMBOLS as readonly string[]).includes(symbol.toUpperCase());
}
