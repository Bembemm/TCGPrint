import { describe, expect, it, vi } from "vitest";
import type { ArtworkCandidate } from "../../core/cards/types";
import { ArtworkQualityHydrator } from "../../src/app/artwork-quality-hydration";
import * as artworkQualityModule from "../../src/app/artwork-quality-hydration";

function candidate(id: string, overrides: Partial<ArtworkCandidate> = {}): ArtworkCandidate {
  return { id, source: "scryfall", identityId: "identity", faceId: "front", originalAvailable: true, ...overrides };
}

describe("progressive artwork quality hydration", () => {
  it("probes only the rendered batch, keeps concurrency bounded, skips known results, and coalesces duplicate scheduling", async () => {
    let active = 0;
    let peak = 0;
    const hydrated: string[] = [];
    const prepare = vi.fn(async (item: ArtworkCandidate) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return { ...item, effectiveDpi: 798 };
    });
    const hydrator = new ArtworkQualityHydrator<ArtworkCandidate>(prepare, (_key, item) => hydrated.push(item.id), () => undefined, 3);
    const all = Array.from({ length: 1200 }, (_, index) => candidate(`candidate-${index}`));
    const rendered = all.slice(0, 60);

    hydrator.reset("card/front/scryfall");
    hydrator.schedule("card/front/scryfall", rendered);
    hydrator.schedule("card/front/scryfall", rendered);
    await vi.waitFor(() => expect(hydrated).toHaveLength(60));

    expect(prepare).toHaveBeenCalledTimes(60);
    expect(peak).toBe(3);
    expect(hydrated).not.toContain("candidate-800");
    hydrator.schedule("card/front/scryfall", [
      candidate("already-verified", { effectiveDpi: 600 }),
      candidate("already-cached", { originalCached: true }),
      candidate("no-original", { originalAvailable: false }),
      ...rendered,
    ]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(prepare).toHaveBeenCalledTimes(60);
    hydrator.cancel();
  });

  it("aborts old generations and ignores a late quality result after card or face changes", async () => {
    let oldSignal: AbortSignal | undefined;
    const hydrated: string[] = [];
    const prepare = vi.fn(async (item: ArtworkCandidate, signal: AbortSignal) => {
      if (item.id === "old-card") {
        oldSignal = signal;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return { ...item, effectiveDpi: 600 };
    });
    const hydrator = new ArtworkQualityHydrator<ArtworkCandidate>(prepare, (_key, item) => hydrated.push(item.id), () => undefined, 2);

    hydrator.reset("old-card/front/scryfall");
    hydrator.schedule("old-card/front/scryfall", [candidate("old-card")]);
    await vi.waitFor(() => expect(oldSignal).toBeDefined());
    hydrator.reset("new-card/back/scryfall");
    hydrator.schedule("new-card/back/scryfall", [candidate("new-card-back", { faceId: "back" })]);
    await vi.waitFor(() => expect(hydrated).toEqual(["new-card-back"]));
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(oldSignal?.aborted).toBe(true);
    expect(hydrated).toEqual(["new-card-back"]);
    hydrator.cancel();
  });

  it.each([
    ["card", "card-a/front/mpc/filters-1/revision-1", "card-b/front/mpc/filters-1/revision-1"],
    ["face", "card-a/front/mpc/filters-1/revision-1", "card-a/back/mpc/filters-1/revision-1"],
    ["provider", "card-a/front/mpc/filters-1/revision-1", "card-a/front/scryfall/filters-1/revision-1"],
    ["MPC filters", "card-a/front/mpc/filters-1/revision-1", "card-a/front/mpc/filters-2/revision-1"],
    ["catalog revision", "card-a/front/mpc/filters-1/revision-1", "card-a/front/mpc/filters-1/revision-2"],
  ])("does not schedule stale candidates or accept stale callbacks after a %s request change", async (_change, requestA, requestB) => {
    type CatalogResult = { requestKey: string; candidates: ArtworkCandidate[]; catalogTotal: number };
    const module = artworkQualityModule as unknown as Record<string, unknown>;
    const catalogForRequest = module.artworkCatalogForRequest as (
      result: CatalogResult | null,
      requestKey: string,
    ) => CatalogResult;
    const updateCandidateForRequest = module.updateArtworkCatalogCandidate as (
      result: CatalogResult | null,
      requestKey: string,
      candidate: ArtworkCandidate,
    ) => CatalogResult | null;
    expect(catalogForRequest).toBeTypeOf("function");
    expect(updateCandidateForRequest).toBeTypeOf("function");

    const candidateA = candidate("a1");
    const candidateB = candidate("b1");
    let catalog: CatalogResult | null = { requestKey: requestA, candidates: [candidateA], catalogTotal: 1 };
    let currentRequestKey = requestA;
    let resolveA: ((prepared: ArtworkCandidate) => void) | undefined;
    let oldSignal: AbortSignal | undefined;
    const prepared: string[] = [];
    const prepare = vi.fn((item: ArtworkCandidate, signal: AbortSignal) => {
      if (item.id === "a1") {
        oldSignal = signal;
        return new Promise<ArtworkCandidate>((resolve) => { resolveA = resolve; });
      }
      return Promise.resolve({ ...item, effectiveDpi: 798 });
    });
    const commitPrepared = (requestKey: string, item: ArtworkCandidate) => {
      if (currentRequestKey !== requestKey) return;
      catalog = updateCandidateForRequest(catalog, requestKey, item);
      prepared.push(item.id);
    };
    const hydrator = new ArtworkQualityHydrator<ArtworkCandidate>(prepare, commitPrepared, () => undefined, 3);

    hydrator.reset(requestA);
    hydrator.schedule(requestA, catalogForRequest(catalog, requestA).candidates);
    await vi.waitFor(() => expect(oldSignal).toBeDefined());
    expect(prepare).toHaveBeenCalledTimes(1);

    currentRequestKey = requestB;
    hydrator.reset(requestB);
    const whileBLoads = catalogForRequest(catalog, requestB);
    expect(whileBLoads.candidates).toEqual([]);
    hydrator.schedule(requestB, whileBLoads.candidates);
    expect(oldSignal?.aborted).toBe(true);
    expect(prepare).toHaveBeenCalledTimes(1);

    catalog = { requestKey: requestB, candidates: [candidateB], catalogTotal: 1 };
    hydrator.schedule(requestB, catalogForRequest(catalog, requestB).candidates);
    await vi.waitFor(() => expect(prepared).toEqual(["b1"]));
    expect(prepare.mock.calls.map(([item]) => item.id)).toEqual(["a1", "b1"]);

    resolveA?.({ ...candidateA, effectiveDpi: 600 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(prepared).toEqual(["b1"]);
    expect(updateCandidateForRequest(catalog, requestA, { ...candidateA, effectiveDpi: 600 })).toBe(catalog);
    expect(catalog).toMatchObject({ requestKey: requestB, candidates: [{ id: "b1" }] });
    hydrator.cancel();
  });
});
