export type TweetMedia = {
  url: string;
  mimeType: string; // "image/jpeg" | "image/png" | "video/mp4" | "image/gif" | ...
};

export type Tweet = {
  id: string;
  authorHandle: string;
  authorId: string;
  text: string;
  createdAt: Date;
  images: TweetMedia[];
  videoUrl?: string;
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
