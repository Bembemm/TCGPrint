import { describe, expect, it } from "vitest";
import { fallbackToProjectDefaultBack, resolveEffectiveCardBack, restoreAutomaticBackSelection, setWorkingCardBackMode } from "../../../core/cards/back-selection";
import type { BackLibraryAssetReference, WorkingCard } from "../../../core/cards/types";

const dfc: WorkingCard = {
  id: "dfc", quantity: 1, order: 0,
  importSource: { sourceId: "source", importKind: "fixture", entryKind: "card" },
  identityHints: { name: "Front // Back" },
  identity: { id: "scryfall:oracle:dfc", provider: "scryfall", name: "Front // Back", resolutionMethod: "manual", confidence: 1,
    metadata: { layout: "transform", faces: [{ name: "Front" }, { name: "Back" }] } },
  identityResolution: { status: "resolved", candidates: [], confirmed: true },
  faces: [{ id: "front", side: "front", name: "Front" }, { id: "back", side: "back", name: "Back" }],
  selectedArtworkByFace: { back: { candidateId: "upload:manual", source: "upload", identityId: "scryfall:oracle:dfc", faceId: "back", selectionPolicy: "user-selected" } },
  backMode: "manual", backModeSelectionPolicy: "explicit", localArtworkIds: [], mpcReferences: [], faceAssociations: [],
};

describe("card back selection", () => {
  it("uses Project default for an eligible simple card but never substitutes a DFC auto face or manual lock", () => {
    const projectBack: BackLibraryAssetReference = { assetId: `back:${"a".repeat(64)}`, sha256: "a".repeat(64), format: "png" };
    const missingDfc: WorkingCard = { ...dfc, backMode: "auto", backModeSelectionPolicy: "automatic", selectedArtworkByFace: { front: dfc.selectedArtworkByFace.front! } };
    const effectiveDfc = resolveEffectiveCardBack(missingDfc, projectBack);
    const normal: WorkingCard = { ...missingDfc, identity: null, faces: [dfc.faces[0]!], backMode: "auto" };
    const missingManual: WorkingCard = { ...dfc, selectedArtworkByFace: {}, backMode: "manual", backModeSelectionPolicy: "explicit" };

    expect(fallbackToProjectDefaultBack(missingDfc, effectiveDfc, projectBack)).toMatchObject({ mode: "auto", status: "missing" });
    expect(fallbackToProjectDefaultBack(normal, resolveEffectiveCardBack(normal), projectBack)).toMatchObject({ mode: "project-default", status: "available", asset: projectBack });
    expect(fallbackToProjectDefaultBack(missingManual, resolveEffectiveCardBack(missingManual), projectBack)).toMatchObject({ mode: "manual", status: "missing" });
  });

  it("explicitly restoring Auto clears a user-selected face override after an intermediate none mode", () => {
    const blank = setWorkingCardBackMode(dfc, "none");
    const restored = restoreAutomaticBackSelection(blank);

    expect(restored).toMatchObject({ backMode: "auto", backModeSelectionPolicy: "automatic" });
    expect(restored.selectedArtworkByFace.back).toBeUndefined();
  });

  it("restores normal cards to Project default and removes a generic manual asset reference", () => {
    const normal: WorkingCard = { ...dfc, identity: null, faces: [dfc.faces[0]!], selectedArtworkByFace: {},
      backMode: "manual", manualBackAsset: { assetId: `back:${"a".repeat(64)}`, sha256: "a".repeat(64), format: "png" } };
    const restored = restoreAutomaticBackSelection(normal);

    expect(restored).toMatchObject({ backMode: "project-default", backModeSelectionPolicy: "automatic" });
    expect("manualBackAsset" in restored).toBe(false);
  });
});
