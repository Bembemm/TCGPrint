import { describe, expect, it, vi } from "vitest";
import type { CardIdentity } from "../../core/cards/types";
import type { WorkingCardMpcReference } from "../../core/cards/types";
import type { ArtworkProvider } from "../../artwork/types";
import { ArtworkCatalog } from "../../artwork/catalog";
import { MpcReferenceArtworkProvider } from "../../artwork/mpc-reference-provider";

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

  it("preserves MPC reference IDs and selected artwork without attempting network lookup", async () => {
    const mpc = new MpcReferenceArtworkProvider();
    const catalog = new ArtworkCatalog([scryfallProvider, uploadProvider, mpc]);
    const references: WorkingCardMpcReference[] = [{ faceId: "front", importedAssetId: "import-a", providerAssetId: "mpc-provider-17", selectedArtworkId: "mpc-choice-21", slots: ["A1", "A2"], availableLocally: false }];
    const candidates = await catalog.search(identity, { source: "mpc", mpcReferences: references });
    expect(candidates).toMatchObject([{ providerAssetId: "mpc-provider-17", selectedArtworkId: "mpc-choice-21", originalAvailable: false }]);
    expect(candidates[0].id).toMatch(/^mpc:[a-f0-9]{64}$/);
    await expect(mpc.getOriginal(candidates[0].id)).rejects.toMatchObject({ code: "ARTWORK_MISSING" });
    expect(scryfallProvider.searchArtwork).not.toHaveBeenCalled();
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
});
