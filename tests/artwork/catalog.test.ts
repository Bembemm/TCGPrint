import { describe, expect, it, vi } from "vitest";
import type { CardIdentity } from "../../core/cards/types";
import type { ArtworkProvider, ProviderHealth } from "../../artwork/types";
import { ArtworkCatalog } from "../../artwork/catalog";
import { MpcArtworkFilterValidationError } from "../../artwork/mpc-contract";

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
      mpc: { available: false, degraded: true, message: "MPC artwork provider is temporarily degraded." },
    });
    expect(JSON.stringify(catalog.getProviderHealth().mpc)).not.toContain("timed out");
  });

  it("synchronizes recovered provider health when read outside catalog search", () => {
    let health: ProviderHealth = { available: false, degraded: true, message: "Provider is temporarily degraded." };
    const recoveredProvider: ArtworkProvider = {
      source: "mpc",
      getHealth: () => health,
      searchArtwork: async () => [],
      getPreview: async () => undefined,
      getOriginal: async () => { throw new Error("No original"); },
      getCandidate: async () => undefined,
    };
    const catalog = new ArtworkCatalog([recoveredProvider]);

    expect(catalog.getProviderHealth().mpc).toMatchObject({ available: false, degraded: true });
    health = { available: true, degraded: false };

    expect(catalog.getProviderHealth().mpc).toMatchObject({ available: true, degraded: false });
  });

  it("clears catalog error overrides when a provider reports recovery outside search", async () => {
    let health: ProviderHealth = { available: true, degraded: false };
    const failingThenRecovered: ArtworkProvider = {
      source: "mpc",
      getHealth: () => health,
      searchArtwork: async () => {
        health = { available: false, degraded: true, message: "MPC is temporarily degraded." };
        throw new Error("request failed");
      },
      getPreview: async () => undefined,
      getOriginal: async () => {
        health = { available: true, degraded: false };
        throw new Error("unused original");
      },
      getCandidate: async () => undefined,
    };
    const catalog = new ArtworkCatalog([failingThenRecovered]);

    await catalog.search(identity, { source: "mpc" });
    expect(catalog.getProviderHealth().mpc).toMatchObject({ degraded: true, available: false });
    health = { available: true, degraded: false };
    expect(catalog.getProviderHealth().mpc).toMatchObject({ degraded: false, available: true });
  });

  it("preserves catalog-marked MPC degradation and hides upstream text", () => {
    const healthyMpc: ArtworkProvider = {
      source: "mpc",
      getHealth: () => ({ available: true, degraded: false }),
      searchArtwork: async () => [],
      getPreview: async () => undefined,
      getOriginal: async () => { throw new Error("No original"); },
      getCandidate: async () => undefined,
    };
    const catalog = new ArtworkCatalog([healthyMpc]);

    catalog.markProviderDegraded("mpc", new Error("https://private.example/path?token=must-not-leak"));

    const health = catalog.getProviderHealth().mpc;
    expect(health).toMatchObject({ available: false, degraded: true });
    expect(JSON.stringify(health)).not.toContain("private.example");
    expect(JSON.stringify(health)).not.toContain("must-not-leak");
  });

  it("lets MPC filter validation errors reach the API as client errors", async () => {
    const mpc = Object.assign(provider("mpc"), {
      searchArtworkAdvanced: vi.fn(async () => {
        throw new MpcArtworkFilterValidationError("A source ID is not present in the verified MPC catalog.");
      }),
      getFilterCatalogs: vi.fn(async () => ({ sources: [], languages: [], tags: [] })),
      getDiagnostic: vi.fn(() => ({ available: true, degraded: false })),
      refreshCandidate: vi.fn(async () => undefined),
    });
    const catalog = new ArtworkCatalog([mpc]);

    await expect(catalog.search(identity, { source: "mpc", mpcFilters: { sources: [999] } }))
      .rejects.toBeInstanceOf(MpcArtworkFilterValidationError);
    expect(catalog.getProviderHealth().mpc).toMatchObject({ available: true, degraded: false });
  });
});
