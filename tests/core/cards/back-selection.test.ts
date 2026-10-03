import { describe, expect, it } from "vitest";
import { BackSelectionPolicyError, fallbackToProjectDefaultBack, isDoubleFacedIdentity, isEligibleGenericPhysicalBack, resolveEffectiveCardBack, restoreAutomaticBackSelection, selectManualBackArtwork, selectManualBackLibraryAsset, setWorkingCardBackMode } from "../../../core/cards/back-selection";
import type { BackLibraryAssetReference, WorkingCard } from "../../../core/cards/types";
import { selectArtwork as selectWorkingArtwork } from "../../../core/cards/working-set";

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
    const missingManual: WorkingCard = { ...dfc, identity: null, faces: [dfc.faces[0]!], selectedArtworkByFace: {}, backMode: "manual", backModeSelectionPolicy: "explicit" };

    expect(fallbackToProjectDefaultBack(missingDfc, effectiveDfc, projectBack)).toMatchObject({ mode: "auto", status: "missing" });
    expect(fallbackToProjectDefaultBack(normal, resolveEffectiveCardBack(normal), projectBack)).toMatchObject({ mode: "project-default", status: "available", asset: projectBack });
    expect(fallbackToProjectDefaultBack(missingManual, resolveEffectiveCardBack(missingManual), projectBack)).toMatchObject({ mode: "manual", status: "missing" });
  });

  it("keeps a DFC's independently selected real back face when restoring automatic back handling", () => {
    const restored = restoreAutomaticBackSelection(dfc);

    expect(restored).toMatchObject({ backMode: "auto", backModeSelectionPolicy: "automatic" });
    expect(restored.selectedArtworkByFace.back).toEqual(dfc.selectedArtworkByFace.back);
    expect(() => setWorkingCardBackMode(dfc, "project-default")).toThrow(BackSelectionPolicyError);
    expect(() => setWorkingCardBackMode(dfc, "none")).toThrow(BackSelectionPolicyError);
  });

  it("restores normal cards to Project default and removes a generic manual asset reference", () => {
    const normal: WorkingCard = { ...dfc, identity: null, faces: [dfc.faces[0]!], selectedArtworkByFace: {},
      backMode: "manual", manualBackAsset: { assetId: `back:${"a".repeat(64)}`, sha256: "a".repeat(64), format: "png" } };
    const restored = restoreAutomaticBackSelection(normal);

    expect(restored).toMatchObject({ backMode: "project-default", backModeSelectionPolicy: "automatic" });
    expect("manualBackAsset" in restored).toBe(false);
  });

  it("allows Back Library and intentional none for a simple card and preserves a legacy Scryfall back", () => {
    const simple: WorkingCard = { ...dfc, identity: null, faces: [dfc.faces[0]!], selectedArtworkByFace: {}, backMode: "project-default", backModeSelectionPolicy: "automatic" };
    const asset: BackLibraryAssetReference = { assetId: `back:${"e".repeat(64)}`, sha256: "e".repeat(64), format: "png" };
    const librarySelected = selectManualBackLibraryAsset(simple, asset);
    const noBack = setWorkingCardBackMode(simple, "none");
    const legacyArtwork = { candidateId: "scryfall:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:front", source: "scryfall" as const, identityId: "scryfall:oracle:simple", faceId: "front" as const, selectionPolicy: "user-selected" as const };
    const legacy = { ...simple, backMode: "manual" as const, manualBackArtwork: legacyArtwork };

    expect(resolveEffectiveCardBack(librarySelected)).toMatchObject({ mode: "manual", source: "manual-library", asset });
    expect(resolveEffectiveCardBack(noBack)).toMatchObject({ mode: "none", status: "intentional-none" });
    expect(resolveEffectiveCardBack(legacy)).toMatchObject({ mode: "manual", source: "manual-artwork", artwork: legacyArtwork });
  });

  it("accepts only semantic MPC cardbacks for a simple card's generic physical back", () => {
    const simple: WorkingCard = { ...dfc, identity: null, faces: [dfc.faces[0]!], selectedArtworkByFace: {}, backMode: "project-default", backModeSelectionPolicy: "automatic" };
    const valid = { id: "mpc:cardback", source: "mpc" as const, identityId: null, faceId: "back", providerAssetId: "cardback-id", originalAvailable: true, metadata: { cardType: "CARDBACK" } };
    const invalidCandidates = [
      { ...valid, source: "scryfall" as const, metadata: { cardType: "CARD" } },
      { ...valid, source: "upload" as const, metadata: {} },
      { ...valid, metadata: { cardType: "CARD" } },
    ];
    expect(isEligibleGenericPhysicalBack(simple, valid)).toBe(true);
    for (const candidate of invalidCandidates) {
      expect(isEligibleGenericPhysicalBack(simple, candidate)).toBe(false);
      expect(() => selectManualBackArtwork(simple, candidate)).toThrow(BackSelectionPolicyError);
    }
    const selected = selectManualBackArtwork(simple, valid);
    const artwork = selected.manualBackArtwork;

    expect(selected.faces).toHaveLength(1);
    expect(isDoubleFacedIdentity(selected.identity)).toBe(false);
    expect(resolveEffectiveCardBack(selected)).toMatchObject({ mode: "manual", status: "available", source: "manual-artwork", artwork: { source: "mpc", faceId: "back", candidateId: valid.id } });
    const newFront = { candidateId: "scryfall:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb:front", source: "scryfall" as const, identityId: "scryfall:oracle:new-front", faceId: "front" as const, selectionPolicy: "user-selected" };
    const frontChanged = selectWorkingArtwork({ ...selected, identity: { id: "scryfall:oracle:new-front", provider: "scryfall", name: "New front", resolutionMethod: "manual", confidence: 1 } }, "front", newFront);
    expect(frontChanged.manualBackArtwork).toEqual(artwork);
    expect(resolveEffectiveCardBack(frontChanged, { assetId: `back:${"b".repeat(64)}`, sha256: "b".repeat(64), format: "png" })).toMatchObject({ source: "manual-artwork", artwork });
    expect(restoreAutomaticBackSelection(selected)).not.toHaveProperty("manualBackArtwork");
  });

  it("does not allow generic defaults, Back Library assets, or manual cardbacks to replace a DFC face", () => {
    const projectBack: BackLibraryAssetReference = { assetId: `back:${"d".repeat(64)}`, sha256: "d".repeat(64), format: "png" };
    const dfcWithLegacyGeneric: WorkingCard = { ...dfc, manualBackAsset: projectBack };
    expect(resolveEffectiveCardBack(dfcWithLegacyGeneric, projectBack)).toMatchObject({ mode: "auto", source: "dfc-face", artwork: dfc.selectedArtworkByFace.back });
    expect(() => selectManualBackLibraryAsset(dfc, projectBack)).toThrow(BackSelectionPolicyError);
    expect(() => selectManualBackArtwork(dfc, { id: "mpc:back", source: "mpc", identityId: null, faceId: "back", providerAssetId: "cardback-id", originalAvailable: true, metadata: { cardType: "CARDBACK" } })).toThrow(BackSelectionPolicyError);
  });
});
