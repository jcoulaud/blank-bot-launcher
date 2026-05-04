import { setTimeout as sleep } from "node:timers/promises";
import { Mutex } from "async-mutex";
import { describe, expect, it } from "vitest";

/**
 * Tests the drain pattern from src/index.ts. We can't easily test the live
 * SIGTERM handler without spawning a child process, so we test the underlying
 * primitive: the Mutex + waitForUnlock approach used to drain in-flight work.
 */
describe("graceful shutdown drain pattern (D4)", () => {
  it("waitForUnlock resolves immediately when nothing is in flight", async () => {
    const m = new Mutex();
    const start = Date.now();
    await m.waitForUnlock();
    expect(Date.now() - start).toBeLessThan(50);
  });

  it("waitForUnlock blocks until current critical section completes", async () => {
    const m = new Mutex();
    const order: string[] = [];

    const work = m.runExclusive(async () => {
      order.push("work-start");
      await sleep(50);
      order.push("work-end");
    });

    // Give the work a tick to acquire the lock
    await sleep(5);
    const drainPromise = m.waitForUnlock().then(() => order.push("drained"));
    await Promise.all([work, drainPromise]);

    expect(order).toEqual(["work-start", "work-end", "drained"]);
  });

  it("Promise.race yields 'timeout' when work exceeds timeout budget", async () => {
    const m = new Mutex();
    const work = m.runExclusive(async () => {
      await sleep(200);
    });
    await sleep(5);

    const result = await Promise.race([
      m.waitForUnlock().then(() => "drained" as const),
      sleep(50).then(() => "timeout" as const),
    ]);
    expect(result).toBe("timeout");
    await work;
  });

  it("Promise.race yields 'drained' when work fits within timeout budget", async () => {
    const m = new Mutex();
    const work = m.runExclusive(async () => {
      await sleep(20);
    });
    await sleep(5);

    const result = await Promise.race([
      m.waitForUnlock().then(() => "drained" as const),
      sleep(200).then(() => "timeout" as const),
    ]);
    expect(result).toBe("drained");
    await work;
  });
});
