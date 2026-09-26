import { describe, expect, it, vi } from "vitest";
import type { CardIdentity } from "../../core/cards/types";
import type { ArtworkProvider, ProviderHealth } from "../../artwork/types";
import { ArtworkCatalog } from "../../artwork/catalog";

const identity: CardIdentity = { id: "identity:sol-ring", provider: "scryfall", name: "Sol Ring", resolutionMethod: "manual", confidence: 1 };
function provider(source: "scryfall" | "upload" | "mpc", items = [] as any[], shouldFail = false): ArtworkProvider {
  return {
    source,
    searchArtwork: vi.fn(async () => { if (shouldFail) throw new Error(`${source} unavailable`); return items; }),
    getPreview: vi.fn(async () => { throw new Error("No preview"); }),
    getOriginal: vi.fn(async () => { throw new Error("No original"); }),
    getCandidate: vi.fn(async () => undefined),
  };
}

const scryfallProvider = provider("scryfall", [{ id: "scryfall:a", source: "scryfall", identityId: identity.id, faceId: "front", originalAvailable: true }]);
const uploadProvider = provider("upload", [{ id: "upload:a", source: "upload", identityId: identity.id, faceId: "front", originalAvailable: true }]);
const mpcProvider = provider("mpc", [{ id: "mpc:a", source: "mpc", identityId: identity.id, faceId: "front", originalAvailable: false }]);

describe("ArtworkCatalog", () => {
  it("aggregates and filters all, Scryfall, upload, and MPC sources", async () => {
    const catalog = new ArtworkCatalog([scryfallProvider, uploadProvider, mpcProvider]);
    await expect(catalog.search(identity, { source: "all" })).resolves.toHaveLength(3);
    await expect(catalog.search(identity, { source: "scryfall" })).resolves.toMatchObject([{ source: "scryfall" }]);
    await expect(catalog.search(identity, { source: "upload" })).resolves.toMatchObject([{ source: "upload" }]);
    await expect(catalog.search(identity, { source: "mpc" })).resolves.toMatchObject([{ source: "mpc" }]);
  });

  it("reports provider health independently while keeping other providers available", async () => {
    const broken = provider("scryfall", [], true);
    const local = provider("upload", [{ id: "upload:still-works", source: "upload", identityId: identity.id, faceId: "front", originalAvailable: true }]);
    const catalog = new ArtworkCatalog([broken, local, mpcProvider]);
    const candidates = await catalog.search(identity, { source: "all" });
    expect(candidates.map((candidate) => candidate.id)).toContain("upload:still-works");
    expect(catalog.getProviderHealth()).toMatchObject({
      scryfall: { available: false, degraded: true, message: "scryfall unavailable" },
      upload: { available: true, degraded: false },
      mpc: { available: true, degraded: false },
    });
  });

  it("reflects MPC health after an original-fetch failure outside catalog search", async () => {
    let health: ProviderHealth = { available: true, degraded: false };
    const mpc: ArtworkProvider = {
      source: "mpc",
      getHealth: () => health,
      searchArtwork: async () => [],
      getPreview: async () => undefined,
      getOriginal: async () => {
        health = { available: false, degraded: true, message: "MPC original timed out" };
        throw new Error("MPC original timed out");
      },
      getCandidate: async () => undefined,
    };
    const catalog = new ArtworkCatalog([mpc]);

    await expect(catalog.getOriginal(`mpc:${"c".repeat(64)}`)).rejects.toThrow("MPC original timed out");
    expect(catalog.getProviderHealth()).toMatchObject({
      mpc: { available: false, degraded: true, message: "MPC original timed out" },
    });
  });
});
