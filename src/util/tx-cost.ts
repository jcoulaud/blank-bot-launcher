import { type Connection, LAMPORTS_PER_SOL, type PublicKey } from "@solana/web3.js";

export type MeasureCostArgs = {
  connection: Connection;
  signature: string;
  payer: PublicKey;
  timeoutMs?: number;
  pollIntervalMs?: number;
};

export type MeasureCostsArgs = Omit<MeasureCostArgs, "signature"> & {
  signatures: readonly string[];
};

/**
 * Returns the wallet's lamport outflow for a confirmed transaction
 * (network fee + program fees + rent), measured as
 * `preBalances[payerIdx] - postBalances[payerIdx]`.
 *
 * Polls `getTransaction` until the tx is visible. Confirmation is reached
 * before `launch.create` returns, but RPC indexing for `getTransaction`
 * can lag a few hundred ms. Throws if the tx never appears within the
 * timeout, or if the payer isn't in the static account keys.
 */
export async function measureTxCostLamports(args: MeasureCostArgs): Promise<number> {
  const timeout = args.timeoutMs ?? 30_000;
  const poll = args.pollIntervalMs ?? 500;
  const deadline = Date.now() + timeout;
  let lastErr: unknown = null;

  while (Date.now() < deadline) {
    try {
      const tx = await args.connection.getTransaction(args.signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
      if (tx?.meta) {
        const keys = tx.transaction.message.staticAccountKeys;
        const idx = keys.findIndex((k) => k.equals(args.payer));
        if (idx < 0) {
          throw new Error(
            `payer ${args.payer.toBase58()} not in tx ${args.signature} static account keys`,
          );
        }
        // Solana places the fee payer at index 0 of staticAccountKeys.
        // If the SDK ever returns a transaction where the payer isn't index 0,
        // the cost math we apply (preBalances[idx] - postBalances[idx]) might
        // not be the wallet's true outflow - bail rather than silently mislead.
        if (idx !== 0) {
          throw new Error(
            `payer ${args.payer.toBase58()} unexpectedly at index ${idx} (expected 0) in tx ${args.signature}`,
          );
        }
        const pre = tx.meta.preBalances[idx];
        const post = tx.meta.postBalances[idx];
        if (pre === undefined || post === undefined) {
          throw new Error(`tx ${args.signature} meta missing balance for payer index ${idx}`);
        }
        assertSafeLamports(pre, `tx ${args.signature} pre balance`);
        assertSafeLamports(post, `tx ${args.signature} post balance`);
        return pre - post;
      }
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, poll));
  }
  const reason = lastErr instanceof Error ? `: ${lastErr.message}` : "";
  throw new Error(
    `measureTxCostLamports timed out after ${timeout}ms for ${args.signature}${reason}`,
  );
}

export async function measureTxCostsLamports(args: MeasureCostsArgs): Promise<number> {
  const signatures = uniqueSignatures(args.signatures);
  if (signatures.length === 0) {
    throw new Error("measureTxCostsLamports requires at least one signature");
  }

  let total = 0;
  for (const signature of signatures) {
    total += await measureTxCostLamports({ ...args, signature });
  }
  assertSafeLamports(total, "total transaction cost");
  if (total < 0) {
    throw new Error("total transaction cost is negative; cannot treat as launch cost");
  }
  return total;
}

export async function measureTxCostSol(args: MeasureCostArgs): Promise<number> {
  return lamportsToSol(await measureTxCostLamports(args));
}

export async function measureTxCostsSol(args: MeasureCostsArgs): Promise<number> {
  return lamportsToSol(await measureTxCostsLamports(args));
}

export function lamportsToSol(lamports: number): number {
  assertSafeLamports(lamports, "lamports");
  return lamports / LAMPORTS_PER_SOL;
}

function uniqueSignatures(signatures: readonly string[]): string[] {
  return [...new Set(signatures.map((signature) => signature.trim()).filter(Boolean))];
}

function assertSafeLamports(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} is not a safe integer lamport value`);
  }
}
