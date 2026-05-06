import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { passesThreshold } from "../brain/classifier.js";
import type { BacktestReportEntry } from "./report.js";

export const DEFAULT_CALIBRATION_THRESHOLDS = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95] as const;

const CalibrationLabelSchema = z.enum([
  "good_launch",
  "false_positive",
  "false_negative",
  "true_negative",
  "ignore",
]);

const CalibrationLabelRecordSchema = z.object({
  tweetId: z.string().min(1),
  label: CalibrationLabelSchema,
  note: z.string().optional(),
});

const CalibrationLabelFileSchema = z.union([
  z.array(CalibrationLabelRecordSchema),
  z.object({ labels: z.array(CalibrationLabelRecordSchema) }),
]);

export type CalibrationLabel = z.infer<typeof CalibrationLabelSchema>;
export type CalibrationLabelRecord = z.infer<typeof CalibrationLabelRecordSchema>;

export type CalibrationSlice = {
  key: string;
  labeled: number;
  actualPositive: number;
  predictedPositive: number;
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  trueNegative: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
};

export type CalibrationThresholdReport = CalibrationSlice & {
  threshold: number;
};

export type CalibrationReport = {
  labelsPath: string;
  promptVersion: string;
  labeledTweets: number;
  unlabeledTweets: number;
  ignoredTweets: number;
  labelCounts: Record<CalibrationLabel, number>;
  thresholds: CalibrationThresholdReport[];
  byAccount: CalibrationSlice[];
  byMediaType: CalibrationSlice[];
};

type LabeledEntry = {
  entry: BacktestReportEntry;
  label: CalibrationLabelRecord;
};

export function loadCalibrationLabels(path: string): Map<string, CalibrationLabelRecord> {
  const absPath = resolve(path);
  const raw = readFileSync(absPath, "utf8").trim();
  if (!raw) return new Map();

  const parsed = parseLabelFile(raw);
  const labels = Array.isArray(parsed) ? parsed : parsed.labels;
  return new Map(labels.map((label) => [label.tweetId, label]));
}

export function buildCalibrationReport(args: {
  entries: BacktestReportEntry[];
  labels: ReadonlyMap<string, CalibrationLabelRecord>;
  labelsPath: string;
  promptVersion: string;
  thresholds?: readonly number[];
}): CalibrationReport {
  const thresholds = args.thresholds ?? DEFAULT_CALIBRATION_THRESHOLDS;
  const labeled = entriesWithLabels(args.entries, args.labels);
  const included = labeled.filter(({ label }) => label.label !== "ignore");
  const ignoredTweets = labeled.length - included.length;
  const labelCounts = emptyLabelCounts();
  for (const { label } of labeled) labelCounts[label.label] += 1;

  const reportThresholds = thresholds.map((threshold) => ({
    threshold,
    ...sliceMetrics(`threshold_${threshold}`, included, threshold),
  }));
  const operatingThreshold = pickOperatingThreshold(thresholds);

  return {
    labelsPath: resolve(args.labelsPath),
    promptVersion: args.promptVersion,
    labeledTweets: included.length,
    unlabeledTweets: args.entries.length - labeled.length,
    ignoredTweets,
    labelCounts,
    thresholds: reportThresholds,
    byAccount: groupedSlices(included, operatingThreshold, ({ entry }) => entry.tweet.authorHandle),
    byMediaType: groupedSlices(included, operatingThreshold, ({ entry }) => entry.tweet.mediaType),
  };
}

function parseLabelFile(raw: string): z.infer<typeof CalibrationLabelFileSchema> {
  if (!raw.startsWith("[") && !raw.startsWith("{")) return parseJsonlLabels(raw);
  try {
    return parseJsonLabels(raw);
  } catch (err) {
    if (raw.startsWith("{")) return parseJsonlLabels(raw);
    throw err;
  }
}

function parseJsonLabels(raw: string): z.infer<typeof CalibrationLabelFileSchema> {
  return CalibrationLabelFileSchema.parse(JSON.parse(raw));
}

function parseJsonlLabels(raw: string): CalibrationLabelRecord[] {
  const labels: CalibrationLabelRecord[] = [];
  const lines = raw.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    try {
      labels.push(CalibrationLabelRecordSchema.parse(JSON.parse(trimmed)));
    } catch (err) {
      throw new Error(`Invalid calibration label JSONL on line ${index + 1}: ${String(err)}`);
    }
  }
  return labels;
}

function entriesWithLabels(
  entries: BacktestReportEntry[],
  labels: ReadonlyMap<string, CalibrationLabelRecord>,
): LabeledEntry[] {
  return entries.flatMap((entry) => {
    const label = labels.get(entry.tweet.id);
    return label ? [{ entry, label }] : [];
  });
}

function emptyLabelCounts(): Record<CalibrationLabel, number> {
  return {
    good_launch: 0,
    false_positive: 0,
    false_negative: 0,
    true_negative: 0,
    ignore: 0,
  };
}

function groupedSlices(
  entries: LabeledEntry[],
  threshold: number,
  keyFor: (entry: LabeledEntry) => string,
): CalibrationSlice[] {
  const byKey = new Map<string, LabeledEntry[]>();
  for (const entry of entries) {
    const key = keyFor(entry);
    byKey.set(key, [...(byKey.get(key) ?? []), entry]);
  }
  return [...byKey.entries()]
    .map(([key, values]) => sliceMetrics(key, values, threshold))
    .sort((a, b) => b.labeled - a.labeled || a.key.localeCompare(b.key));
}

function pickOperatingThreshold(thresholds: readonly number[]): number {
  return thresholds.includes(0.85) ? 0.85 : (thresholds[Math.floor(thresholds.length / 2)] ?? 0.85);
}

function sliceMetrics(key: string, entries: LabeledEntry[], threshold: number): CalibrationSlice {
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let trueNegative = 0;

  for (const entry of entries) {
    const predictedPositive = predictsLaunch(entry.entry, threshold);
    const actualPositive = isPositiveLabel(entry.label.label);
    if (predictedPositive && actualPositive) truePositive += 1;
    else if (predictedPositive && !actualPositive) falsePositive += 1;
    else if (!predictedPositive && actualPositive) falseNegative += 1;
    else trueNegative += 1;
  }

  const predictedPositive = truePositive + falsePositive;
  const actualPositive = truePositive + falseNegative;
  const precision = predictedPositive === 0 ? null : truePositive / predictedPositive;
  const recall = actualPositive === 0 ? null : truePositive / actualPositive;
  const f1 =
    precision === null || recall === null || precision + recall === 0
      ? null
      : (2 * precision * recall) / (precision + recall);

  return {
    key,
    labeled: entries.length,
    actualPositive,
    predictedPositive,
    truePositive,
    falsePositive,
    falseNegative,
    trueNegative,
    precision,
    recall,
    f1,
  };
}

function predictsLaunch(entry: BacktestReportEntry, threshold: number): boolean {
  return entry.result.classification
    ? passesThreshold(entry.result.classification, threshold)
    : entry.result.decision === "launched" || entry.result.decision === "dry_run";
}

function isPositiveLabel(label: CalibrationLabel): boolean {
  return label === "good_launch" || label === "false_negative";
}
