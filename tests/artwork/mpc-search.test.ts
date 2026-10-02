import { describe, expect, it } from "vitest";
import type { ArtworkCandidate, CardIdentity } from "../../core/cards/types";
import { buildMpcSearchCacheKey } from "../../artwork/mpc-cache-key";
import { normalizeMpcArtworkFilters } from "../../artwork/mpc-contract";
import { rankMpcCandidates } from "../../artwork/mpc-ranking";

const identity: CardIdentity = {
  id: "card:1",
  provider: "manual",
  name: "Sol Ring",
  setCode: "cmm",
  collectorNumber: "396",
  resolutionMethod: "manual",
  confidence: 1,
};

function candidate(id: string, metadata: Record<string, unknown>, extra: Partial<ArtworkCandidate> = {}): ArtworkCandidate {
  return {
    id,
    source: "mpc",
    identityId: identity.id,
    faceId: "front",
    originalAvailable: true,
    metadata,
    ...extra,
  };
}

describe("MPC TCGPrint search contract", () => {
  it("normalizes bounded filters and removes ordering differences from set-like arrays", () => {
    expect(normalizeMpcArtworkFilters({
      minimumDpi: 300,
      maximumDpi: 1200,
      sources: [8, 3, 8],
      includeTags: [" Full Art ", "Proxy"],
      excludeTags: ["Foil"],
      languages: ["EN", "fr"],
      preferredSources: [8, 3],
      preferredLanguages: ["fr", "EN"],
      preferredTags: ["Extended", "full art"],
    })).toEqual({
      minimumDpi: 300,
      maximumDpi: 1200,
      sources: [3, 8],
      includeTags: ["full art", "proxy"],
      excludeTags: ["foil"],
      languages: ["en", "fr"],
      preferredSources: [8, 3],
      preferredLanguages: ["fr", "en"],
      preferredTags: ["extended", "full art"],
    });
  });

  it("rejects out-of-range DPI and fields outside the TCGPrint filter contract", () => {
    expect(() => normalizeMpcArtworkFilters({ minimumDpi: -1 })).toThrow();
    expect(() => normalizeMpcArtworkFilters({ maximumDpi: 10_001 })).toThrow();
    expect(() => normalizeMpcArtworkFilters({ fuzzySearch: true })).toThrow();
  });

  it("uses the same cache key for equivalent unordered filter arrays", () => {
    const first = normalizeMpcArtworkFilters({ sources: [8, 3], includeTags: ["Proxy", "Full Art"], languages: ["fr", "EN"] });
    const second = normalizeMpcArtworkFilters({ sources: [3, 8, 8], includeTags: ["full art", "proxy"], languages: ["en", "FR"] });

    expect(buildMpcSearchCacheKey("Sol Ring", "front", first, [3, 8])).toBe(
      buildMpcSearchCacheKey("Sol Ring", "front", second, [8, 3, 8]),
    );
  });

  it("separates cache entries when any result-changing filter changes", () => {
    const base = normalizeMpcArtworkFilters({ minimumDpi: 300 });
    const variants = [
      normalizeMpcArtworkFilters({ minimumDpi: 301 }),
      normalizeMpcArtworkFilters({ maximumDpi: 1200 }),
      normalizeMpcArtworkFilters({ sources: [41] }),
      normalizeMpcArtworkFilters({ includeTags: ["Proxy"] }),
      normalizeMpcArtworkFilters({ excludeTags: ["Foil"] }),
      normalizeMpcArtworkFilters({ languages: ["en"] }),
      normalizeMpcArtworkFilters({ preferredSources: [41] }),
      normalizeMpcArtworkFilters({ preferredLanguages: ["en"] }),
      normalizeMpcArtworkFilters({ preferredTags: ["Proxy"] }),
    ];
    const key = buildMpcSearchCacheKey("Sol Ring", "front", base, [41]);

    for (const filters of variants) {
      expect(buildMpcSearchCacheKey("Sol Ring", "front", filters, [41])).not.toBe(key);
    }
    expect(buildMpcSearchCacheKey("Sol Ring", "back", base, [41])).not.toBe(key);
    expect(buildMpcSearchCacheKey("Sol Ring", "front", base, [42])).not.toBe(key);
  });
});

describe("MPC deterministic ranking", () => {
  it("honors explicit preferences, exact printing metadata, and MPC priority without using effective DPI", () => {
    const filters = normalizeMpcArtworkFilters({ preferredSources: [8], preferredLanguages: ["fr"], preferredTags: ["extended"] });
    const candidates = [
      candidate("mpc:c", { sourceId: 3, language: "en", tags: ["Extended"], priority: 10, dpi: 900 }),
      candidate("mpc:a", { sourceId: 3, language: "en", tags: ["Extended"], priority: 1, dpi: 900, canonicalCard: { expansionCode: "CMM", collectorNumber: "396" } }, { effectiveDpi: 100 }),
      candidate("mpc:b", { sourceId: 8, language: "fr", tags: ["extended"], priority: 0, dpi: 1200 }, { effectiveDpi: 2400 }),
    ];

    expect(rankMpcCandidates(candidates, identity, filters).map(({ id }) => id)).toEqual(["mpc:b", "mpc:a", "mpc:c"]);
  });

  it("uses a stable candidate ID as the final tie-breaker", () => {
    const tied = [
      candidate("mpc:z", { sourceId: 41, priority: 2, dpi: 600 }),
      candidate("mpc:a", { sourceId: 41, priority: 2, dpi: 600 }),
    ];
    const filters = normalizeMpcArtworkFilters({});

    expect(rankMpcCandidates(tied, identity, filters).map(({ id }) => id)).toEqual(["mpc:a", "mpc:z"]);
    expect(rankMpcCandidates(tied.slice().reverse(), identity, filters).map(({ id }) => id)).toEqual(["mpc:a", "mpc:z"]);
  });
});
