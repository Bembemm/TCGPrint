import { describe, expect, it, vi } from "vitest";
import { createBoundedSemaphore, createCoalescedRequestRegistry, mapConcurrent } from "../../artwork/mpc-request-coalescer";

describe("MPC request coordination", () => {
  it("shares identical requests and lets the remaining consumer finish after one cancels", async () => {
    const registry = createCoalescedRequestRegistry<number>();
    let resolveRequest!: (value: number) => void;
    let requestSignal: AbortSignal | undefined;
    const factory = vi.fn((signal: AbortSignal) => {
      requestSignal = signal;
      return new Promise<number>((resolve) => { resolveRequest = resolve; });
    });
    const firstController = new AbortController();
    const first = registry.run("same", firstController.signal, factory);
    const second = registry.run("same", undefined, factory);
    firstController.abort();

    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(requestSignal?.aborted).toBe(false);
    resolveRequest(42);
    await expect(second).resolves.toBe(42);
    expect(registry.size).toBe(0);
  });

  it("aborts the shared request after its last consumer cancels and clears rejected entries", async () => {
    const registry = createCoalescedRequestRegistry<number>();
    let requestSignal: AbortSignal | undefined;
    const controller = new AbortController();
    const request = registry.run("cancelled", controller.signal, (signal) => {
      requestSignal = signal;
      return new Promise<number>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    });
    await Promise.resolve();
    controller.abort();

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(registry.size).toBe(0));
    expect(requestSignal?.aborted).toBe(true);

    await expect(registry.run("reject", undefined, async () => { throw new Error("failed"); })).rejects.toThrow("failed");
    expect(registry.size).toBe(0);
  });

  it("bounds concurrent batch work and preserves input order", async () => {
    let active = 0;
    let peak = 0;
    const result = await mapConcurrent([4, 3, 2, 1], 2, async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return value * 10;
    });

    expect(result).toEqual([40, 30, 20, 10]);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("bounds requests globally and removes cancelled waiters from the queue", async () => {
    const semaphore = createBoundedSemaphore(1);
    let releaseActive!: () => void;
    const activeGate = new Promise<void>((resolve) => { releaseActive = resolve; });
    const first = semaphore.run(async () => activeGate);
    await Promise.resolve();
    const queuedController = new AbortController();
    const queued = semaphore.run(async () => 2, queuedController.signal);
    queuedController.abort();

    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    releaseActive();
    await expect(first).resolves.toBeUndefined();
    await expect(semaphore.run(async () => 3)).resolves.toBe(3);
    expect(semaphore).toMatchObject({ active: 0, peak: 1, limit: 1 });
  });
});
