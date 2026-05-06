import { stripZeroWidthAndBidi } from "../util/text.js";

export type TweetMedia = {
  url: string;
};

export type TweetAttachedMedia = {
  type: "photo" | "video" | "animated_gif";
  url?: string;
  previewImageUrl?: string;
};

export type Tweet = {
  id: string;
  authorHandle: string;
  authorId: string;
  text: string;
  createdAt: Date;
  media: TweetAttachedMedia[];
  images: TweetMedia[];
  isReply: boolean;
  isRetweet: boolean;
  isQuoteTweet: boolean;
  quotedTweet?: Tweet;
};

export type TweetHandler = (tweet: Tweet) => Promise<void>;

export interface TweetSource {
  start(handler: TweetHandler): Promise<void>;
  stop(): Promise<void>;
}

export type TweetMediaType = "no_image" | "tweet_image" | "quoted_image" | "video";

export function getPrimaryLaunchImage(tweet: Tweet): TweetMedia | undefined {
  return tweet.images[0] ?? tweet.quotedTweet?.images[0];
}

export function getPrimaryLaunchImageSource(tweet: Tweet): "tweet" | "quoted_tweet" | null {
  if (tweet.images[0]) return "tweet";
  if (tweet.quotedTweet?.images[0]) return "quoted_tweet";
  return null;
}

export function hasAttachedVideo(tweet: Tweet): boolean {
  return (
    tweet.media.some((media) => media.type === "video") ||
    Boolean(tweet.quotedTweet && hasAttachedVideo(tweet.quotedTweet))
  );
}

export function tweetMediaType(tweet: Tweet): TweetMediaType {
  if (hasAttachedVideo(tweet)) return "video";
  if (tweet.images.length > 0) return "tweet_image";
  if ((tweet.quotedTweet?.images.length ?? 0) > 0) return "quoted_image";
  return "no_image";
}

const URL_RE = /\bhttps?:\/\/\S+/gi;
const MENTION_RE = /(^|\s)@\w+/g;
const HAS_LETTER_OR_NUMBER_RE = /[\p{L}\p{N}]/u;

function quoteCommentaryText(text: string): string {
  return stripZeroWidthAndBidi(text.normalize("NFKC"))
    .replace(URL_RE, " ")
    .replace(MENTION_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isQuoteReactionOnly(tweet: Tweet): boolean {
  if (!tweet.isQuoteTweet) return false;
  return !HAS_LETTER_OR_NUMBER_RE.test(quoteCommentaryText(tweet.text));
}
