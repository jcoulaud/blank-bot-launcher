import { Telegraf } from "telegraf";
import { getLogger } from "../logger.js";

const log = getLogger({ pipeline_stage: "telegram" });

export type TelegramConfig = {
  botToken: string;
  chatId: string;
};

export class TelegramNotifier {
  private bot: Telegraf;

  constructor(private readonly config: TelegramConfig) {
    this.bot = new Telegraf(config.botToken);
  }

  async sendLaunchSuccess(args: {
    name: string;
    ticker: string;
    mint: string;
    txSignature: string;
    sourceTweetUrl: string;
  }): Promise<void> {
    const text = [
      `🚀 *Launched* \\$${escapeMd(args.ticker)} — ${escapeMd(args.name)}`,
      `Mint: \`${escapeMd(args.mint)}\``,
      `Tx: https://solscan.io/tx/${escapeMd(args.txSignature)}`,
      `Source: ${escapeMd(args.sourceTweetUrl)}`,
    ].join("\n");
    await this.send(text);
  }

  async sendCapHit(detail: string): Promise<void> {
    await this.send(`🛑 Daily cap reached: ${escapeMd(detail)}`);
  }

  async sendError(args: { tweetId: string; stage: string; message: string }): Promise<void> {
    const text = [
      `❌ Error in stage \`${escapeMd(args.stage)}\``,
      `Tweet: \`${escapeMd(args.tweetId)}\``,
      `Reason: ${escapeMd(args.message)}`,
    ].join("\n");
    await this.send(text);
  }

  private async send(text: string): Promise<void> {
    try {
      await this.bot.telegram.sendMessage(this.config.chatId, text, {
        parse_mode: "MarkdownV2",
        link_preview_options: { is_disabled: true },
      });
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, "telegram send failed");
    }
  }
}

// Telegram MarkdownV2 escapes
function escapeMd(s: string): string {
  return s.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (c) => `\\${c}`);
}
