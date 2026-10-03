import { describe, expect, it, vi } from "vitest";
import type { WorkingCard } from "../../core/cards/types";
import { DEFAULT_PROJECT_SETTINGS, deserializeProjectSnapshot, serializeProjectSnapshot } from "../../persistence/projects/serializer";
import {
  createProjectRestoreLookupGate,
  runProjectRestoreProviderLookup,
} from "../../src/app/project-restore-provider-gate";

describe("project restore provider gate", () => {
  it.each(["filename", "ocr"] as const)("opens a legacy %s Project snapshot unchanged without provider lookups", async (method) => {
    const legacyCard: WorkingCard = {
      id: `legacy-${method}`, quantity: 1, order: 0,
      importSource: { sourceId: "legacy-upload", filename: "Island.png", importKind: "image", entryKind: "custom-card" },
      identityHints: { name: "Island" },
      identity: { id: "scryfall:oracle:legacy-island", provider: "scryfall", name: "Island", resolutionMethod: method, confidence: 0.99 },
      identityResolution: { status: "resolved", method, query: "Island", candidates: [], confirmed: false },
      faces: [{ id: "front", side: "front", importedAssetId: `upload:${"a".repeat(64)}` }],
      selectedArtworkByFace: { front: { candidateId: `upload:${"a".repeat(64)}`, source: "upload", identityId: null, faceId: "front" } },
      backMode: "project-default", backModeSelectionPolicy: "automatic", localArtworkIds: [], mpcReferences: [], faceAssociations: [],
    };
    const openedCard = deserializeProjectSnapshot(serializeProjectSnapshot([legacyCard], DEFAULT_PROJECT_SETTINGS)).cards[0]!;
    const before = structuredClone(openedCard);
    const gate = createProjectRestoreLookupGate(8);
    const artworkProvider = vi.fn(async () => "artwork catalog");
    const identityProvider = vi.fn(async () => "identity details");
    const result = await Promise.all([
      runProjectRestoreProviderLookup(gate, 8, "artwork", artworkProvider),
      runProjectRestoreProviderLookup(gate, 8, "identity", identityProvider),
    ]);

    expect(result).toEqual([{ skipped: true }, { skipped: true }]);
    expect(openedCard).toEqual(before);
    expect(openedCard.identityResolution.method).toBe(method);
    expect(openedCard.identity?.resolutionMethod).toBe(method);
    expect(artworkProvider).not.toHaveBeenCalled();
    expect(identityProvider).not.toHaveBeenCalled();
  });

  it("skips automatic artwork and identity lookups caused by opening, including Strict Mode effect replay", async () => {
    const gate = createProjectRestoreLookupGate(3);
    const artworkLookup = vi.fn(async () => "artwork catalog");
    const identityLookup = vi.fn(async () => "identity details");

    const firstSetup = [
      runProjectRestoreProviderLookup(gate, 3, "artwork", artworkLookup),
      runProjectRestoreProviderLookup(gate, 3, "identity", identityLookup),
    ];
    const strictModeReplay = [
      runProjectRestoreProviderLookup(gate, 3, "artwork", artworkLookup),
      runProjectRestoreProviderLookup(gate, 3, "identity", identityLookup),
    ];
    const skipped = await Promise.all([...firstSetup, ...strictModeReplay]);

    expect(skipped).toEqual([
      { skipped: true },
      { skipped: true },
      { skipped: true },
      { skipped: true },
    ]);
    expect(artworkLookup).not.toHaveBeenCalled();
    expect(identityLookup).not.toHaveBeenCalled();
  });

  it("allows a later user-triggered lookup after the restore suppression expires", async () => {
    const gate = createProjectRestoreLookupGate(4);
    const lookup = vi.fn(async () => "catalog");
    await runProjectRestoreProviderLookup(gate, 4, "artwork", lookup);

    await Promise.resolve();
    const result = await runProjectRestoreProviderLookup(gate, 4, "artwork", lookup);

    expect(result).toEqual({ skipped: false, value: "catalog" });
    expect(lookup).toHaveBeenCalledTimes(1);
  });
});
