import { type Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import { fetchBalanceWithRetry } from "../src/util/balance.js";

const wallet = Keypair.generate();
const noDelay = () => 0;

function fakeConnection(getBalance: ReturnType<typeof vi.fn>): Connection {
  return { getBalance } as unknown as Connection;
}

describe("fetchBalanceWithRetry", () => {
  it("returns ok with sol on first success", async () => {
    const getBalance = vi.fn().mockResolvedValueOnce(2.5 * LAMPORTS_PER_SOL);
    const r = await fetchBalanceWithRetry(fakeConnection(getBalance), wallet, 3, noDelay);
    expect(r).toEqual({ ok: true, sol: 2.5 });
    expect(getBalance).toHaveBeenCalledTimes(1);
  });

  it("retries transient failures and returns ok on later success", async () => {
    const getBalance = vi
      .fn()
      .mockRejectedValueOnce(new Error("rpc 1"))
      .mockRejectedValueOnce(new Error("rpc 2"))
      .mockResolvedValueOnce(0.1 * LAMPORTS_PER_SOL);
    const r = await fetchBalanceWithRetry(fakeConnection(getBalance), wallet, 3, noDelay);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sol).toBeCloseTo(0.1);
    expect(getBalance).toHaveBeenCalledTimes(3);
  });

  it("returns the last error message after exhausting attempts", async () => {
    const getBalance = vi
      .fn()
      .mockRejectedValueOnce(new Error("first"))
      .mockRejectedValueOnce(new Error("second"))
      .mockRejectedValueOnce(new Error("third"));
    const r = await fetchBalanceWithRetry(fakeConnection(getBalance), wallet, 3, noDelay);
    expect(r).toEqual({ ok: false, error: "third" });
    expect(getBalance).toHaveBeenCalledTimes(3);
  });

  it("stringifies non-Error rejections", async () => {
    const getBalance = vi.fn().mockRejectedValueOnce("plain-string");
    const r = await fetchBalanceWithRetry(fakeConnection(getBalance), wallet, 1, noDelay);
    expect(r).toEqual({ ok: false, error: "plain-string" });
  });

  it("makes only one attempt when attempts=1 and does not sleep", async () => {
    const delay = vi.fn(() => 0);
    const getBalance = vi.fn().mockRejectedValueOnce(new Error("nope"));
    await fetchBalanceWithRetry(fakeConnection(getBalance), wallet, 1, delay);
    expect(getBalance).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
  });
});
