// Validates the shutdown drain/timeout race used by the SIGTERM handler in
// src/index.ts.
//
// We re-implement the same Promise.race pattern locally so the test isn't
// coupled to a full bot bootstrap. The shape under test is:
//
//   await Promise.race([
//     mutex.waitForUnlock().then(() => "drained"),
//     sleep(timeoutMs).then(() => "timeout"),
//   ]);
//
// If this race ever stops behaving the way index.ts depends on, the test
// breaks even though it doesn't import index.ts directly.
import { setTimeout as sleep } from "node:timers/promises";
import { Mutex } from "async-mutex";
import { describe, expect, it } from "vitest";

async function drainOrTimeout(mutex: Mutex, timeoutMs: number): Promise<"drained" | "timeout"> {
  return Promise.race([
    mutex.waitForUnlock().then(() => "drained" as const),
    sleep(timeoutMs).then(() => "timeout" as const),
  ]);
}

describe("shutdown mutex drain", () => {
  it("returns 'drained' immediately when mutex is idle", async () => {
    const mutex = new Mutex();
    const result = await drainOrTimeout(mutex, 1000);
    expect(result).toBe("drained");
  });

  it("returns 'drained' once the held lock releases before timeout", async () => {
    const mutex = new Mutex();
    const release = await mutex.acquire();
    setTimeout(release, 50);
    const result = await drainOrTimeout(mutex, 500);
    expect(result).toBe("drained");
  });

  it("returns 'timeout' when the mutex is held longer than the timeout", async () => {
    const mutex = new Mutex();
    const release = await mutex.acquire();
    try {
      const result = await drainOrTimeout(mutex, 100);
      expect(result).toBe("timeout");
    } finally {
      release();
    }
  });
});

describe("shutdown re-entrancy guard", () => {
  // The `shuttingDown` flag prevents a second SIGTERM from running the close
  // path while the first call is still mid-await.
  it("ignores second invocation while first is in flight", async () => {
    let calls = 0;
    let shuttingDown = false;
    const fakeShutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      calls++;
      await sleep(20);
    };
    const a = fakeShutdown();
    const b = fakeShutdown();
    await Promise.all([a, b]);
    expect(calls).toBe(1);
  });
});
