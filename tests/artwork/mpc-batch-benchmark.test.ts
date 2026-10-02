import { describe, expect, it } from "vitest";
import { MPC_BATCH_CONCURRENCY, MPC_HYDRATION_CHUNK_SIZE, MPC_REMOTE_CONCURRENCY, planMpcHydrationBatches } from "../../artwork/mpc-provider";
import { createBoundedSemaphore } from "../../artwork/mpc-request-coalescer";

function ids(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}-${String(index).padStart(3, "0")}`);
}

describe("deterministic MPC request-count benchmark", () => {
  it("reproduces the synthetic identity and revalidation scenarios without network or timing gates", async () => {
    const perIdentity = 8;
    const requestsForIdentities = (count: number) => Array.from({ length: count }, (_, index) => planMpcHydrationBatches(ids(`identity-${index}`, perIdentity)).length).reduce((sum, requestCount) => sum + requestCount, 0);
    const duplicateReferences = Array.from({ length: 100 }, (_, index) => `unique-${String(index % 20).padStart(3, "0")}`);
    const duplicateBatches = planMpcHydrationBatches(duplicateReferences);
    const mixedCacheUniqueAssets = [...ids("warm", 8), ...ids("cold", 8)];
    const mixedCacheBatches = planMpcHydrationBatches(mixedCacheUniqueAssets);

    let active = 0;
    let peak = 0;
    const semaphore = createBoundedSemaphore(MPC_REMOTE_CONCURRENCY);
    await Promise.all(Array.from({ length: 12 }, () => semaphore.run(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
    })));

    expect(requestsForIdentities(1)).toBe(1);
    expect(requestsForIdentities(10)).toBe(10);
    expect(requestsForIdentities(100)).toBe(100);
    expect(duplicateBatches).toHaveLength(1);
    expect(duplicateBatches[0]).toHaveLength(20);
    expect(mixedCacheBatches).toHaveLength(1);
    expect(planMpcHydrationBatches([])).toHaveLength(0);
    expect(MPC_HYDRATION_CHUNK_SIZE).toBe(20);
    expect(MPC_BATCH_CONCURRENCY).toBe(3);
    expect(peak).toBe(MPC_REMOTE_CONCURRENCY);
    expect(semaphore.peak).toBe(MPC_REMOTE_CONCURRENCY);
  });
});
