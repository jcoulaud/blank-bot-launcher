import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildCalibrationReport,
  type CalibrationLabelRecord,
  loadCalibrationLabels,
} from "../src/backtest/calibration.js";
import type { BacktestReportEntry } from "../src/backtest/report.js";
import type { Classification } from "../src/brain/classifier.js";

const baseClassification: Classification = {
  shouldLaunch: true,
  confidence: 0.9,
  launchableMeme: true,
  memeSource: "tweet_text",
  visualAssessment: "none",
  disqualifiers: [],
  reason: "memeable",
};

function entry(
  id: string,
  authorHandle: string,
  mediaType: BacktestReportEntry["tweet"]["mediaType"],
  classification: Classification,
): BacktestReportEntry {
  return {
    tweet: {
      id,
      url: `https://x.com/${authorHandle}/status/${id}`,
      authorHandle,
      authorId: `${authorHandle}-id`,
      text: "doge",
      createdAt: "2026-05-06T12:00:00.000Z",
      imageCount: mediaType === "tweet_image" ? 1 : 0,
      quotedImageCount: mediaType === "quoted_image" ? 1 : 0,
      mediaType,
      isQuoteTweet: mediaType === "quoted_image",
    },
    result: {
      tweetId: id,
      authorHandle,
      decision: "dry_run",
      reason: classification.reason,
      classification,
    },
  };
}

describe("backtest calibration", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "blank-bot-calibration-test-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("loads JSONL labels and reports precision/recall by threshold and slice", () => {
    const labelsPath = join(tmp, "labels.jsonl");
    const labels: CalibrationLabelRecord[] = [
      { tweetId: "t1", label: "good_launch" },
      { tweetId: "t2", label: "false_positive" },
      { tweetId: "t3", label: "false_negative" },
      { tweetId: "t4", label: "ignore" },
    ];
    writeFileSync(labelsPath, labels.map((label) => JSON.stringify(label)).join("\n"));

    const entries = [
      entry("t1", "elonmusk", "tweet_image", baseClassification),
      entry("t2", "elonmusk", "tweet_image", baseClassification),
      entry("t3", "sama", "no_image", { ...baseClassification, confidence: 0.7 }),
      entry("t4", "sama", "no_image", baseClassification),
      entry("unlabeled", "sama", "no_image", baseClassification),
    ];

    const report = buildCalibrationReport({
      entries,
      labels: loadCalibrationLabels(labelsPath),
      labelsPath,
      promptVersion: "classifier-test",
      thresholds: [0.85],
    });

    expect(report.labeledTweets).toBe(3);
    expect(report.unlabeledTweets).toBe(1);
    expect(report.ignoredTweets).toBe(1);
    expect(report.labelCounts.good_launch).toBe(1);
    expect(report.thresholds[0]).toMatchObject({
      threshold: 0.85,
      truePositive: 1,
      falsePositive: 1,
      falseNegative: 1,
      trueNegative: 0,
      precision: 0.5,
      recall: 0.5,
    });
    expect(report.byAccount.find((row) => row.key === "elonmusk")?.falsePositive).toBe(1);
    expect(report.byMediaType.find((row) => row.key === "no_image")?.falseNegative).toBe(1);
  });
});
