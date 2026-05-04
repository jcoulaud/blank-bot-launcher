import { describe, expect, it } from "vitest";
import { type Classification, passesThreshold } from "../src/brain/classifier.js";

describe("passesThreshold", () => {
  it("accepts when shouldLaunch=true and confidence above threshold", () => {
    const c: Classification = { shouldLaunch: true, confidence: 0.9, reason: "memeable" };
    expect(passesThreshold(c, 0.85)).toBe(true);
  });

  it("rejects when confidence is just below threshold", () => {
    const c: Classification = { shouldLaunch: true, confidence: 0.84, reason: "borderline" };
    expect(passesThreshold(c, 0.85)).toBe(false);
  });

  it("rejects when shouldLaunch=false even with high confidence", () => {
    const c: Classification = { shouldLaunch: false, confidence: 0.99, reason: "boring" };
    expect(passesThreshold(c, 0.85)).toBe(false);
  });

  it("accepts at the exact boundary", () => {
    const c: Classification = { shouldLaunch: true, confidence: 0.85, reason: "edge" };
    expect(passesThreshold(c, 0.85)).toBe(true);
  });
});
