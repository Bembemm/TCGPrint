import { describe, expect, it } from "vitest";
import type { ImportResult, ImportedEntry } from "../../../import-engine/types";
import { createWorkingSet, selectArtwork } from "../../../core/cards/working-set";
import { BackSelectionPolicyError } from "../../../core/cards/back-selection";
import type { CardIdentity, SelectedArtwork, WorkingCard } from "../../../core/cards/types";

function result(entries: readonly ImportedEntry[]): ImportResult {
  return {
    sources: [],
    detections: [],
    entries,
    report: {
      summary: {
        totalInputs: 0, recognizedInputs: 0, recognizedEntries: entries.length,
        customCards: 0, deckEntries: entries.length, assets: 0, warnings: 0,
        errors: 0, ambiguousDetections: 0, unknownInputs: 0,
      },
      selectedImporters: [], detections: [], warnings: [], errors: [], mappings: [], pairings: [],
    },
  };
}

const entries: ImportedEntry[] = [
  { id: "entry-b", kind: "deck-card", order: 2, quantity: 6, sourceId: "paste", section: "Sideboard", cardHint: { name: "Island", setCode: "M21", collectorNumber: "265", scryfallId: "scryfall-island", language: "en" } },
  { id: "entry-a", kind: "deck-card", order: 1, quantity: 1, sourceId: "paste", section: "Mainboard", cardHint: { name: "Sol Ring" } },
];

const identity: CardIdentity = {
  id: "scryfall:sol-ring",
  provider: "scryfall",
  name: "Sol Ring",
  scryfallId: "scryfall-sol-ring",
  resolutionMethod: "scryfall-id",
  confidence: 1,
};

function artwork(candidateId: string, source: SelectedArtwork["source"], faceId: "front" | "back" = "front"): SelectedArtwork {
  return { candidateId, source, identityId: identity.id, faceId };
}

describe("session Working Set", () => {
  it("keeps import order, quantity, section, and printing hints without expanding entries", () => {
    const cards = createWorkingSet(result(entries), { idFactory: (entry) => `working-${entry.id}` });

    expect(cards).toHaveLength(2);
    expect(cards.map((card) => [card.id, card.order, card.quantity, card.section])).toEqual([
      ["working-entry-a", 1, 1, "Mainboard"],
      ["working-entry-b", 2, 6, "Sideboard"],
    ]);
    expect(cards.map((card) => [card.backMode, card.backModeSelectionPolicy])).toEqual([
      ["project-default", "automatic"],
      ["project-default", "automatic"],
    ]);
    expect(cards[1].identityHints).toEqual({ name: "Island", setCode: "M21", collectorNumber: "265", scryfallId: "scryfall-island", language: "en" });
    expect(createWorkingSet(result(entries), { idFactory: (entry) => `working-${entry.id}` })[1].id).toBe(cards[1].id);
  });

  it.each([
    ["Island.png", "Island"],
    ["1x Sol Ring [MPC].png", "1x Sol Ring [MPC]"],
  ])("keeps uploaded custom image %s custom instead of promoting its display label to an identity hint", (filename, suggestion) => {
    const custom: ImportedEntry = {
      id: "custom-upload", kind: "custom-card", order: 0, quantity: 1, sourceId: "upload",
      sourceFilename: filename, nameSuggestion: suggestion,
      asset: { id: "uploaded-original", sourceId: "upload", originalFormat: "png", originalBytes: new Uint8Array([1]) },
    };

    const [card] = createWorkingSet(result([custom]), { idFactory: () => "custom-card" });

    expect(card).toMatchObject({
      identity: null,
      identityResolution: { status: "custom", confirmed: true },
      importSource: { filename },
    });
    expect(card.identityHints).toEqual({});
    expect(card.localArtworkIds).toEqual(["uploaded-original"]);
    expect(card.importSource.identityHintOrigin).toBeUndefined();
  });

  it("retains explicit cardHint provenance on a custom image without using its display label as identity", () => {
    const custom: ImportedEntry = {
      id: "custom-with-card-hint", kind: "custom-card", order: 0, quantity: 1, sourceId: "upload",
      sourceFilename: "Island.png", nameSuggestion: "Island", cardHint: { name: "Sol Ring" },
      asset: { id: "uploaded-original", sourceId: "upload", originalFormat: "png", originalBytes: new Uint8Array([1]) },
    };

    const [card] = createWorkingSet(result([custom]), { idFactory: () => "custom-card" });

    expect(card.identityHints).toEqual({ name: "Sol Ring" });
    expect(card.importSource.identityHintOrigin).toBe("explicit-card-hint");
  });

  it("carries the import engine's folder front/back pairing into its WorkingCard", () => {
    const front: ImportedEntry = { id: "front-entry", kind: "custom-card", order: 0, quantity: 1, sourceId: "front", asset: { id: "front-asset", sourceId: "front", originalFormat: "png" } };
    const back: ImportedEntry = { id: "back-entry", kind: "custom-card", order: 1, quantity: 1, sourceId: "back", asset: { id: "back-asset", sourceId: "back", originalFormat: "png" } };
    const imported = result([front, back]);
    const pairedResult: ImportResult = {
      ...imported,
      report: {
        ...imported.report,
        pairings: [{ frontAssetId: "front-asset", backAssetId: "back-asset", confidence: 0.99, reason: "same folder and matching front/back suffix", accepted: false }],
      },
    };

    const cards = createWorkingSet(pairedResult, { idFactory: (entry) => `working-${entry.id}` });

    expect(cards[0].faceAssociations).toEqual([{
      slot: "folder-pair",
      frontAssetId: "front-asset",
      backAssetId: "back-asset",
      confidence: 0.99,
      reason: "same folder and matching front/back suffix",
      accepted: false,
    }]);
    expect(cards[1].faceAssociations).toEqual([]);
  });

  it("keeps MPC front/back refs without pretending missing files are downloaded and supports independent DFC selections", () => {
    const mpcEntry: ImportedEntry = {
      id: "mpc-1", kind: "mpc-order-card", order: 0, quantity: 2, sourceId: "order.xml", slots: ["A1", "A2"],
      front: { side: "front", name: "Delver of Secrets", slots: ["A1", "A2"], asset: { id: "front-asset", sourceId: "order.xml", originalFormat: "mpc-reference", providerAssetId: "front-provider", selectedArtworkId: "front-selected" } },
      back: { side: "back", name: "Insectile Aberration", slots: ["A1", "A2"], asset: { id: "back-asset", sourceId: "order.xml", originalFormat: "mpc-reference", providerAssetId: "back-provider", selectedArtworkId: "back-selected" } },
      faceAssociations: [{ slot: "A1", frontAssetId: "front-asset", backAssetId: "back-asset" }],
    };
    const [card] = createWorkingSet(result([mpcEntry]), { idFactory: () => "working-mpc" });

    expect(card.faces.map((face) => face.side)).toEqual(["front", "back"]);
    expect(card.mpcReferences.map((reference) => [reference.providerAssetId, reference.selectedArtworkId])).toEqual([
      ["front-provider", "front-selected"], ["back-provider", "back-selected"],
    ]);
    expect(card.selectedArtworkByFace.front).toMatchObject({ source: "mpc", providerAssetId: "front-provider", selectedArtworkId: "front-selected" });
    expect(card.selectedArtworkByFace.back).toMatchObject({ source: "mpc", providerAssetId: "back-provider", selectedArtworkId: "back-selected" });
    expect(card.backMode).toBe("manual");
    expect(card.backModeSelectionPolicy).toBe("explicit");
    expect(card.mpcReferences.every((reference) => reference.availableLocally === false)).toBe(true);

    const dfcIdentity: CardIdentity = {
      ...identity,
      name: "Delver of Secrets // Insectile Aberration",
      metadata: { layout: "transform", faces: [{ name: "Delver of Secrets" }, { name: "Insectile Aberration" }] },
    };
    const withIdentity = { ...card, identity: dfcIdentity };
    const withFrontUpload = selectArtwork(withIdentity, "front", artwork("upload:abc", "upload"));
    const withBackScryfall = selectArtwork(withFrontUpload, "back", artwork("scryfall:xyz", "scryfall", "back"));
    expect(withBackScryfall.id).toBe(card.id);
    expect(withBackScryfall.identity?.id).toBe(identity.id);
    expect(withBackScryfall.backMode).toBe("manual");
    expect(withBackScryfall.backModeSelectionPolicy).toBe("explicit");
    expect(withBackScryfall.selectedArtworkByFace).toMatchObject({ front: { source: "upload" }, back: { source: "scryfall" } });
    expect(withBackScryfall.mpcReferences).toEqual(card.mpcReferences);
  });

  it("rejects a fake back face for a simple Magic identity while preserving custom two-face cards", () => {
    const [simple] = createWorkingSet(result([entries[1]]), { idFactory: () => "simple-card" });
    const simpleWithIdentity = {
      ...simple,
      identity,
      faces: [{ id: "front", side: "front" as const }, { id: "back", side: "back" as const }],
    };
    const scryfallBack = artwork("scryfall:back-face", "scryfall", "back");
    const customTwoFace: WorkingCard = { ...simpleWithIdentity, identity: null };

    expect(() => selectArtwork(simpleWithIdentity, "back", scryfallBack)).toThrow(BackSelectionPolicyError);
    expect(selectArtwork(customTwoFace, "back", scryfallBack).selectedArtworkByFace.back).toEqual(scryfallBack);
  });

  it("does not make identity part of artwork selection or change it when correcting artwork", () => {
    const [card] = createWorkingSet(result([entries[1]]), { idFactory: () => "working-stable" });
    const identified = { ...card, identity };

    const uploaded = selectArtwork(identified, "front", artwork("upload:sol-ring", "upload"));
    const changed = selectArtwork(uploaded, "front", artwork("scryfall:printing-2", "scryfall"));

    expect(changed.id).toBe("working-stable");
    expect(changed.identity).toEqual(identity);
    expect(changed.selectedArtworkByFace.front?.candidateId).toBe("scryfall:printing-2");
    expect(changed.localArtworkIds).toEqual(uploaded.localArtworkIds);
  });
});
