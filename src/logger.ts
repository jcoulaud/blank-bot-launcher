import pino, { type Logger } from "pino";

const isDev = process.env.NODE_ENV !== "production";

export const rootLogger: Logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  ...(isDev
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,hostname" },
        },
      }
    : {}),
});

export type LogContext = {
  tweet_id?: string;
  author_handle?: string;
  pipeline_stage?: string;
  mint?: string;
  [key: string]: unknown;
};

export function getLogger(context: LogContext = {}): Logger {
  return rootLogger.child(context);
}
