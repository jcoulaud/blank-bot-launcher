import { setTimeout as sleep } from "node:timers/promises";
import type { Connection, Keypair } from "@solana/web3.js";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";

export type BalanceResult = { ok: true; sol: number } | { ok: false; error: string };

export async function fetchBalanceWithRetry(
  connection: Connection,
  wallet: Keypair,
  attempts = 3,
  delayMs = (i: number) => 500 * (i + 1),
): Promise<BalanceResult> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const lamports = await connection.getBalance(wallet.publicKey);
      return { ok: true, sol: lamports / LAMPORTS_PER_SOL };
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await sleep(delayMs(i));
    }
  }
  return { ok: false, error: lastErr instanceof Error ? lastErr.message : String(lastErr) };
}
