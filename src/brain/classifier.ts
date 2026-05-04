import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";
import { getLogger } from "../logger.js";
import type { Tweet } from "../sources/tweet-source.js";
import { buildClassifierPrompt, PROMPT_VERSION } from "./prompts.js";

export const ClassificationSchema = z.object({
  shouldLaunch: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(300),
});

export type Classification = z.infer<typeof ClassificationSchema>;

export type ClassifierOptions = {
  model: LanguageModel;
  threshold: number;
};

export async function classifyTweet(
  tweet: Tweet,
  options: ClassifierOptions,
): Promise<Classification> {
  const log = getLogger({
    tweet_id: tweet.id,
    author_handle: tweet.authorHandle,
    pipeline_stage: "classify",
  });

  const prompt = buildClassifierPrompt(tweet);
  const messages: Parameters<typeof generateObject>[0]["messages"] = [
    {
      role: "user",
      content: [
        { type: "text", text: prompt },
        // Multimodal: include the first tweet image if present
        ...(tweet.images[0]
          ? [{ type: "image" as const, image: new URL(tweet.images[0].url) }]
          : []),
      ],
    },
  ];

  const start = Date.now();
  const result = await generateObject({
    model: options.model,
    schema: ClassificationSchema,
    messages,
  });
  log.info(
    {
      prompt_version: PROMPT_VERSION,
      duration_ms: Date.now() - start,
      should_launch: result.object.shouldLaunch,
      confidence: result.object.confidence,
    },
    "classifier output",
  );
  return result.object;
}

export function passesThreshold(classification: Classification, threshold: number): boolean {
  return classification.shouldLaunch && classification.confidence >= threshold;
}
