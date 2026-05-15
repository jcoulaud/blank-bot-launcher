import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";
import { getLogger } from "../logger.js";
import { getPrimaryLaunchImage, type Tweet } from "../sources/tweet-source.js";
import { buildClassifierPrompt } from "./prompts.js";

const MemeSourceSchema = z.enum(["tweet_text", "tweet_image", "tweet_and_image", "none"]);
const VisualAssessmentSchema = z.enum([
  "none",
  "meme_template",
  "reaction_image",
  "visual_joke_subject",
  "ordinary_photo_or_video",
  "market_data_or_chart",
  "app_or_ai_screenshot",
  "announcement_or_product_ui",
  "unclear_or_irrelevant",
]);
const DisqualifierSchema = z.enum([
  "announcement_or_promo",
  "app_or_ai_screenshot",
  "author_rejects_premise",
  "image_text_extraction_only",
  "informational_or_technical",
  "market_data_or_chart",
  "no_self_contained_joke",
  "normal_conversation",
  "prompt_injection",
  "reserved_or_existing_ticker",
  "unclear_joke",
]);

export const ClassificationSchema = z.object({
  shouldLaunch: z.boolean(),
  confidence: z.number().min(0).max(1),
  launchableMeme: z.boolean(),
  memeSource: MemeSourceSchema,
  visualAssessment: VisualAssessmentSchema,
  disqualifiers: z.array(DisqualifierSchema),
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
  const primaryImage = getPrimaryLaunchImage(tweet);
  const messages: Parameters<typeof generateObject>[0]["messages"] = [
    {
      role: "user",
      content: [
        { type: "text", text: prompt },
        // Multimodal: include the launch-relevant image, including quoted-tweet media.
        ...(primaryImage ? [{ type: "image" as const, image: new URL(primaryImage.url) }] : []),
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
      duration_ms: Date.now() - start,
      should_launch: result.object.shouldLaunch,
      confidence: result.object.confidence,
    },
    "classifier output",
  );
  return result.object;
}

export function passesThreshold(classification: Classification, threshold: number): boolean {
  const disqualifyingVisuals = new Set<Classification["visualAssessment"]>([
    "market_data_or_chart",
    "app_or_ai_screenshot",
    "announcement_or_product_ui",
    "unclear_or_irrelevant",
  ]);

  return (
    classification.shouldLaunch &&
    classification.confidence >= threshold &&
    classification.launchableMeme &&
    classification.memeSource !== "none" &&
    !disqualifyingVisuals.has(classification.visualAssessment) &&
    classification.disqualifiers.length === 0
  );
}
