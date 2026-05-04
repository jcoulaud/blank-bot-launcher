import pino, { type Logger } from "pino";

const isDev = process.env.NODE_ENV !== "production";

// Strip secrets and signed transactions before logs are serialized.
const REDACT_PATHS = [
  "*.SOLANA_PRIVATE_KEY",
  "*.PINATA_JWT",
  "*.X_BEARER_TOKEN",
  "*.BLANK_API_KEY",
  "*.GOOGLE_GENERATIVE_AI_API_KEY",
  "*.bearerToken",
  "*.apiKey",
  "*.jwt",
  "*.secretKey",
  "*.privateKey",
  "*.signedTransactions",
  "env.SOLANA_PRIVATE_KEY",
  "env.PINATA_JWT",
  "env.X_BEARER_TOKEN",
  "env.BLANK_API_KEY",
  "env.GOOGLE_GENERATIVE_AI_API_KEY",
  "err.signedTransactions",
];

export const rootLogger: Logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: { paths: REDACT_PATHS, remove: true },
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
