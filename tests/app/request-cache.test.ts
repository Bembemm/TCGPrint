import { describe, expect, it } from "vitest";
import { clearRequestCache, createRequestCache, discardInflightCachedRequest, getOrCreateCachedRequest, updateResolvedRequestCache } from "../../src/app/request-cache";

describe("getOrCreateCachedRequest", () => {
  it("reuses an in-flight request and its settled value for the same key", async () => {
    const cache = createRequestCache<string>();
    let calls = 0;
    let resolveRequest: ((value: string) => void) | undefined;
    const load = () => {
      calls += 1;
      return new Promise<string>((resolve) => { resolveRequest = resolve; });
    };

    const first = getOrCreateCachedRequest(cache, "identity/front/all", load);
    const concurrent = getOrCreateCachedRequest(cache, "identity/front/all", load);
    await Promise.resolve();

    expect(concurrent).toBe(first);
    expect(calls).toBe(1);
    resolveRequest?.("catalog");
    await expect(first).resolves.toBe("catalog");
    expect(cache.inflight.has("identity/front/all")).toBe(false);
    expect(cache.resolved.get("identity/front/all")).toBe("catalog");
    await expect(getOrCreateCachedRequest(cache, "identity/front/all", load)).resolves.toBe("catalog");
    expect(calls).toBe(1);
  });

  it("removes rejected requests and lets a later retry succeed", async () => {
    const cache = createRequestCache<string>();
    let attempts = 0;
    const load = () => ++attempts === 1
      ? Promise.reject(new Error("provider unavailable"))
      : Promise.resolve("catalog recovered");

    const first = getOrCreateCachedRequest(cache, "identity/back/all", load);
    await expect(first).rejects.toThrow("provider unavailable");
    expect(cache.inflight.has("identity/back/all")).toBe(false);
    expect(cache.resolved.has("identity/back/all")).toBe(false);

    const restored = getOrCreateCachedRequest(cache, "identity/back/all", load);
    expect(restored).not.toBe(first);
    await expect(restored).resolves.toBe("catalog recovered");
    expect(attempts).toBe(2);
    expect(cache.resolved.get("identity/back/all")).toBe("catalog recovered");
  });

  it("removes aborted requests and lets a later retry succeed", async () => {
    const cache = createRequestCache<string>();
    let attempts = 0;
    const first = getOrCreateCachedRequest(cache, "identity/modal/back", () => {
      attempts += 1;
      return Promise.reject(new DOMException("request aborted", "AbortError"));
    });

    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(cache.inflight.has("identity/modal/back")).toBe(false);
    expect(cache.resolved.has("identity/modal/back")).toBe(false);

    await expect(getOrCreateCachedRequest(cache, "identity/modal/back", () => {
      attempts += 1;
      return Promise.resolve("catalog after abort");
    })).resolves.toBe("catalog after abort");
    expect(attempts).toBe(2);
  });

  it("lets an aborting owner discard its in-flight request before an immediate retry", async () => {
    const cache = createRequestCache<string>();
    let rejectFirst: ((error: Error) => void) | undefined;
    let resolveSecond: ((value: string) => void) | undefined;

    const first = getOrCreateCachedRequest(cache, "identity/strict-mode/front", () => new Promise<string>((_resolve, reject) => {
      rejectFirst = reject;
    }));
    await Promise.resolve();
    expect(cache.inflight.get("identity/strict-mode/front")).toBe(first);

    expect(discardInflightCachedRequest(cache, "identity/strict-mode/front", first)).toBe(true);

    const second = getOrCreateCachedRequest(cache, "identity/strict-mode/front", () => new Promise<string>((resolve) => {
      resolveSecond = resolve;
    }));
    await Promise.resolve();
    expect(second).not.toBe(first);
    expect(cache.inflight.get("identity/strict-mode/front")).toBe(second);

    rejectFirst?.(new DOMException("signal is aborted without reason", "AbortError"));
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(cache.inflight.get("identity/strict-mode/front")).toBe(second);

    resolveSecond?.("fresh catalog");
    await expect(second).resolves.toBe("fresh catalog");
    expect(cache.resolved.get("identity/strict-mode/front")).toBe("fresh catalog");
  });

  it("does not let an older rejection remove a newer request for the same key", async () => {
    const cache = createRequestCache<string>();
    let rejectOld: ((error: Error) => void) | undefined;
    let resolveNew: ((value: string) => void) | undefined;
    const oldRequest = getOrCreateCachedRequest(cache, "identity/race/front", () => new Promise<string>((_resolve, reject) => {
      rejectOld = reject;
    }));
    await Promise.resolve();

    cache.inflight.delete("identity/race/front");
    const newRequest = getOrCreateCachedRequest(cache, "identity/race/front", () => new Promise<string>((resolve) => {
      resolveNew = resolve;
    }));
    await Promise.resolve();
    expect(cache.inflight.get("identity/race/front")).toBe(newRequest);

    rejectOld?.(new Error("old request rejected"));
    await expect(oldRequest).rejects.toThrow("old request rejected");
    expect(cache.inflight.get("identity/race/front")).toBe(newRequest);

    resolveNew?.("new request value");
    await expect(newRequest).resolves.toBe("new request value");
    expect(cache.resolved.get("identity/race/front")).toBe("new request value");
  });

  it("keeps different keys independent", async () => {
    const cache = createRequestCache<string>();
    let calls = 0;
    const loader = (value: string) => () => {
      calls += 1;
      return Promise.resolve(value);
    };

    const front = getOrCreateCachedRequest(cache, "identity/front/all", loader("front"));
    const back = getOrCreateCachedRequest(cache, "identity/back/all", loader("back"));
    await expect(front).resolves.toBe("front");
    await expect(back).resolves.toBe("back");
    expect(calls).toBe(2);
    expect(cache.resolved.get("identity/front/all")).toBe("front");
    expect(cache.resolved.get("identity/back/all")).toBe("back");
  });

  it("updates one resolved artwork candidate without reloading or changing other cache keys", async () => {
    const cache = createRequestCache<{ candidates: { id: string; effectiveDpi?: number; originalCached?: boolean }[] }>();
    let calls = 0;
    const loadCatalog = (ids: string[]) => () => {
      calls += 1;
      return Promise.resolve({ candidates: ids.map((id) => ({ id, effectiveDpi: 72, originalCached: false })) });
    };
    const key = "identity/front/all/references-a";
    const otherKey = "identity/back/all/references-b";

    const original = await getOrCreateCachedRequest(cache, key, loadCatalog(["candidate-prepared", "candidate-unchanged"]));
    const other = await getOrCreateCachedRequest(cache, otherKey, loadCatalog(["candidate-other-key"]));
    const preparedCandidate = { id: "candidate-prepared", effectiveDpi: 300, originalCached: true };

    expect(updateResolvedRequestCache(cache, key, (cached) => ({
      ...cached,
      candidates: cached.candidates.map((candidate) => candidate.id === preparedCandidate.id ? preparedCandidate : candidate),
    }))).toBe(true);

    await expect(getOrCreateCachedRequest(cache, key, loadCatalog(["unexpected-reload"]))).resolves.toEqual({
      candidates: [preparedCandidate, original.candidates[1]],
    });
    await expect(getOrCreateCachedRequest(cache, otherKey, loadCatalog(["unexpected-other-reload"]))).resolves.toBe(other);
    expect(cache.resolved.get(key)?.candidates).toEqual([preparedCandidate, original.candidates[1]]);
    expect(cache.resolved.get(otherKey)).toBe(other);
    expect(calls).toBe(2);
  });

  it("invalidates resolved results when a new import changes the artwork catalog", async () => {
    const cache = createRequestCache<string>();
    let calls = 0;
    const load = () => Promise.resolve(`catalog-${++calls}`);

    await expect(getOrCreateCachedRequest(cache, "custom:artwork-picker/front/all", load)).resolves.toBe("catalog-1");
    clearRequestCache(cache);
    await expect(getOrCreateCachedRequest(cache, "custom:artwork-picker/front/all", load)).resolves.toBe("catalog-2");
    expect(calls).toBe(2);
  });

  it("does not let an older success repopulate a cache after invalidation", async () => {
    const cache = createRequestCache<string>();
    let resolveOld: ((value: string) => void) | undefined;
    let resolveNew: ((value: string) => void) | undefined;
    const oldRequest = getOrCreateCachedRequest(cache, "custom:artwork-picker/front/all", () => new Promise<string>((resolve) => {
      resolveOld = resolve;
    }));
    await Promise.resolve();

    clearRequestCache(cache);
    const newRequest = getOrCreateCachedRequest(cache, "custom:artwork-picker/front/all", () => new Promise<string>((resolve) => {
      resolveNew = resolve;
    }));
    await Promise.resolve();

    resolveOld?.("stale catalog");
    await expect(oldRequest).resolves.toBe("stale catalog");
    expect(cache.inflight.get("custom:artwork-picker/front/all")).toBe(newRequest);
    expect(cache.resolved.has("custom:artwork-picker/front/all")).toBe(false);

    resolveNew?.("fresh catalog");
    await expect(newRequest).resolves.toBe("fresh catalog");
    expect(cache.resolved.get("custom:artwork-picker/front/all")).toBe("fresh catalog");
  });
});
