import { describe, expect, it } from "vitest";
import {
  formatReason,
  formatSolThreeDecimals,
  formatSolTwoDecimals,
  formatUsd,
  pillClass,
} from "../src/dashboard/render.js";
import type { Decision } from "../src/store/db.js";

describe("formatReason", () => {
  it("returns empty string for null", () => {
    expect(formatReason(null)).toBe("");
  });

  it("collapses whitespace runs into single spaces", () => {
    expect(formatReason("foo   bar\n\tbaz")).toBe("foo bar baz");
  });

  it("trims leading and trailing whitespace", () => {
    expect(formatReason("   hello   ")).toBe("hello");
  });

  it("returns short messages unchanged", () => {
    expect(formatReason("daily_count_cap")).toBe("daily_count_cap");
  });

  it("truncates messages longer than 240 chars and appends ellipsis", () => {
    const long = "x".repeat(500);
    const out = formatReason(long);
    expect(out.length).toBe(243); // 240 chars + "..."
    expect(out.endsWith("...")).toBe(true);
    expect(out.startsWith("xxx")).toBe(true);
  });

  it("trims any whitespace before the ellipsis when truncating", () => {
    const padded = `${"a".repeat(238)}    ${"b".repeat(20)}`;
    const out = formatReason(padded.replace(/\s+/g, " "));
    expect(out.endsWith(" ...")).toBe(false);
    expect(out.endsWith("...")).toBe(true);
  });

  it("does not truncate messages exactly at the 240-char boundary", () => {
    const exact = "y".repeat(240);
    expect(formatReason(exact)).toBe(exact);
  });
});

describe("pillClass", () => {
  it("maps every Decision value to a unique pill class", () => {
    const decisions: Decision[] = [
      "launched",
      "dry_run",
      "skipped_low_score",
      "skipped_validation",
      "skipped_safety",
      "skipped_error",
    ];
    const classes = decisions.map((d) => pillClass(d));
    expect(classes).toEqual([
      "pill-launched",
      "pill-dry-run",
      "pill-low",
      "pill-validation",
      "pill-safety",
      "pill-error",
    ]);
    // Sanity check the switch is not collapsing branches.
    expect(new Set(classes).size).toBe(decisions.length);
  });
});

describe("formatUsd", () => {
  it("keeps sub-cent X API unit costs visible", () => {
    expect(formatUsd(0.005)).toBe("$0.005");
    expect(formatUsd(0.01)).toBe("$0.010");
  });

  it("uses cents for larger totals", () => {
    expect(formatUsd(1.2)).toBe("$1.20");
  });
});

describe("formatSolTwoDecimals", () => {
  it("always renders recent launch costs with two decimal places", () => {
    expect(formatSolTwoDecimals(1)).toBe("1.00");
    expect(formatSolTwoDecimals(0.0123)).toBe("0.01");
    expect(formatSolTwoDecimals(0)).toBe("0.00");
  });
});

describe("formatSolThreeDecimals", () => {
  it("renders dashboard SOL spent values with three decimal places", () => {
    expect(formatSolThreeDecimals(1)).toBe("1.000");
    expect(formatSolThreeDecimals(0.094613495)).toBe("0.095");
    expect(formatSolThreeDecimals(0)).toBe("0.000");
  });
});
