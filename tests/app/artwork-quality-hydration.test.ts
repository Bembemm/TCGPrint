import { describe, expect, it, vi } from "vitest";
import type { ArtworkCandidate } from "../../core/cards/types";
import { ArtworkQualityHydrator } from "../../src/app/artwork-quality-hydration";

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
});
