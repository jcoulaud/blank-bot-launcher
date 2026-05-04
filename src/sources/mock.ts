import type { Tweet, TweetHandler, TweetSource } from "./tweet-source.js";

/**
 * In-memory TweetSource. Used for tests and the --replay CLI flag.
 * `start()` resolves immediately after dispatching the queued tweets.
 */
export class MockTweetSource implements TweetSource {
  private queue: Tweet[] = [];
  private running = false;

  enqueue(tweet: Tweet): void {
    this.queue.push(tweet);
  }

  async start(handler: TweetHandler): Promise<void> {
    this.running = true;
    for (const tweet of this.queue) {
      if (!this.running) break;
      await handler(tweet);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
  }
}
