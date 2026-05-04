// Zero-width and bidi-override characters. Stripped from any text the bot
// echoes into prompts or token metadata so visually identical strings can't
// hide content from a human reviewer (homoglyph/RTLO tricks).
export const ZERO_WIDTH_AND_BIDI_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g;

export function stripZeroWidthAndBidi(s: string): string {
  return s.replace(ZERO_WIDTH_AND_BIDI_RE, "");
}
