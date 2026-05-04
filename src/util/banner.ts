import type { CliFlags } from "../cli.js";
import type { Config } from "../config.js";

export type BannerArgs = {
  env: Config["env"];
  accounts: Config["accounts"];
  walletPubkey: string;
  balanceSol: number;
  flags: CliFlags;
};

export function buildBannerLines(args: BannerArgs): string[] {
  const { env, walletPubkey, balanceSol, flags } = args;
  const network = describeNetwork(env.RPC_URL);
  const mode = flags.backtest
    ? `BACKTEST ${flags.backtestLimit}/account  (dry-run, isolated DB)`
    : flags.dryRun
      ? "DRY-RUN  (no SDK calls)"
      : flags.checkConfig
        ? "CHECK-CONFIG"
        : flags.replayTweetId
          ? `REPLAY ${flags.replayTweetId}`
          : "LIVE";
  const dashLine = "=".repeat(56);
  return [
    dashLine,
    " blank-bot starting",
    ` Network:    ${network}`,
    ` Wallet:     ${walletPubkey.slice(0, 6)}...${walletPubkey.slice(-4)}`,
    ` Balance:    ${balanceSol.toFixed(4)} SOL`,
    ` Caps:       ${env.MAX_SOL_PER_LAUNCH} SOL/launch | ${env.MAX_LAUNCHES_PER_DAY}/day | ${env.MAX_SOL_PER_DAY} SOL/day`,
    ` LLM:        ${env.LLM_MODEL}`,
    ` Image:      ${env.IMAGE_MODEL}`,
    ` Accounts:   ${args.accounts.accounts.length} followed`,
    ` Dashboard:  ${env.DASHBOARD_PORT ? `http://localhost:${env.DASHBOARD_PORT}` : "disabled"}`,
    ` Mode:       ${mode}${flags.force ? "  +FORCE" : ""}`,
    dashLine,
  ];
}

/**
 * Map an RPC URL to a network label by hostname so a custom RPC named
 * `my-mainnet-fork.example.com` doesn't get mislabeled as `mainnet-beta`
 * just because its hostname contains "mainnet".
 */
export function describeNetwork(rpcUrl: string): "mainnet-beta" | "devnet" | "testnet" | "custom" {
  let host: string;
  try {
    host = new URL(rpcUrl).hostname.toLowerCase();
  } catch {
    return "custom";
  }
  if (host === "api.mainnet-beta.solana.com" || host.endsWith(".mainnet-beta.solana.com")) {
    return "mainnet-beta";
  }
  if (host === "api.devnet.solana.com" || host.endsWith(".devnet.solana.com")) {
    return "devnet";
  }
  if (host === "api.testnet.solana.com" || host.endsWith(".testnet.solana.com")) {
    return "testnet";
  }
  return "custom";
}

export function buildBalanceWarning(args: Pick<BannerArgs, "balanceSol" | "env">): string | null {
  const { balanceSol, env } = args;
  if (balanceSol <= env.WARN_IF_BALANCE_ABOVE_SOL) return null;
  return (
    `WARNING: hot wallet balance (${balanceSol.toFixed(2)} SOL) exceeds ` +
    `WARN_IF_BALANCE_ABOVE_SOL=${env.WARN_IF_BALANCE_ABOVE_SOL}. Move excess to a cold wallet.`
  );
}

export function printBanner(args: BannerArgs): void {
  console.log(buildBannerLines(args).join("\n"));
  const warning = buildBalanceWarning(args);
  if (warning) console.log(warning);
}
