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
