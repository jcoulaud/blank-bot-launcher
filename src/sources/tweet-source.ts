export type TweetMedia = {
  url: string;
};

export type Tweet = {
  id: string;
  authorHandle: string;
  authorId: string;
  text: string;
  createdAt: Date;
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
