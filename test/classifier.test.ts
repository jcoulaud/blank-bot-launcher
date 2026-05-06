import { describe, expect, it } from "vitest";
import { type Classification, passesThreshold } from "../src/brain/classifier.js";

function classification(overrides: Partial<Classification> = {}): Classification {
  return {
    shouldLaunch: true,
    confidence: 0.9,
    launchableMeme: true,
    memeSource: "tweet_text",
    visualAssessment: "none",
    disqualifiers: [],
    reason: "memeable",
    ...overrides,
  };
}

describe("passesThreshold", () => {
  it("accepts when shouldLaunch=true and confidence above threshold", () => {
    const c = classification();
    expect(passesThreshold(c, 0.85)).toBe(true);
  });

  it("rejects when confidence is just below threshold", () => {
    const c = classification({ confidence: 0.84, reason: "borderline" });
    expect(passesThreshold(c, 0.85)).toBe(false);
  });

  it("rejects when shouldLaunch=false even with high confidence", () => {
    const c = classification({ shouldLaunch: false, confidence: 0.99, reason: "boring" });
    expect(passesThreshold(c, 0.85)).toBe(false);
  });

  it("accepts at the exact boundary", () => {
    const c = classification({ confidence: 0.85, reason: "edge" });
    expect(passesThreshold(c, 0.85)).toBe(true);
  });

  it("rejects market data and chart screenshots even with high confidence", () => {
    const c = classification({
      confidence: 0.95,
      visualAssessment: "market_data_or_chart",
      disqualifiers: ["market_data_or_chart"],
      reason: "chart screenshot",
    });
    expect(passesThreshold(c, 0.85)).toBe(false);
  });

  it("rejects AI/app screenshots and image-text extraction candidates", () => {
    const c = classification({
      confidence: 0.95,
      visualAssessment: "app_or_ai_screenshot",
      disqualifiers: ["app_or_ai_screenshot", "image_text_extraction_only"],
      reason: "screenshot text extraction",
    });
    expect(passesThreshold(c, 0.85)).toBe(false);
  });

  it("rejects when no self-contained meme source was found", () => {
    const c = classification({
      confidence: 0.95,
      launchableMeme: false,
      memeSource: "none",
      disqualifiers: ["no_self_contained_joke"],
      reason: "emoji reaction to announcement",
    });
    expect(passesThreshold(c, 0.85)).toBe(false);
  });
});
