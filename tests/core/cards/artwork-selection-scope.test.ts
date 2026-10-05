import { describe, expect, it } from "vitest";
import { applyArtworkSelectionScope, applyArtworkSelectionScopeInPhysicalOrder, applyGenericBackScope, applyGenericBackScopeInPhysicalOrder, ArtworkSelectionScopeError, validateArtworkCandidateForCard } from "../../../core/cards/artwork-selection-scope";
import type { ArtworkCandidate, SelectedArtwork, WorkingCard } from "../../../core/cards/types";
import { createPhysicalOrder } from "../../../core/cards/physical-instance-order";

const identity = { id: "scryfall:oracle:island", provider: "scryfall", name: "Island", resolutionMethod: "manual" as const, confidence: 1 };
const sameNameDifferentIdentity = { ...identity, id: "scryfall:oracle:other-island", name: "Island" };
const firstArtwork: SelectedArtwork = { candidateId: "scryfall:one:front", source: "scryfall", identityId: identity.id, faceId: "front" };
const secondArtwork: SelectedArtwork = { candidateId: "scryfall:two:front", source: "scryfall", identityId: identity.id, faceId: "front" };

function card(id: string, order: number, options: Partial<WorkingCard> = {}): WorkingCard {
  return {
    id, quantity: 1, order,
    importSource: { sourceId: `source:${id}`, importKind: "fixture", entryKind: "card" },
    identityHints: { name: "Island" }, identity: { ...identity },
    identityResolution: { status: "resolved", candidates: [], confirmed: true },
    faces: [{ id: "front", side: "front", name: "Island" }], selectedArtworkByFace: { front: firstArtwork },
    backMode: "project-default", backModeSelectionPolicy: "automatic", localArtworkIds: [], mpcReferences: [], faceAssociations: [],
    ...options,
  };
}

const dfc = card("delver", 1, {
  identity: { ...identity, id: "scryfall:oracle:delver", name: "Delver of Secrets // Insectile Aberration", metadata: { layout: "transform", faces: [{ name: "Delver of Secrets" }, { name: "Insectile Aberration" }] } },
  faces: [{ id: "front", side: "front", name: "Delver of Secrets" }, { id: "back", side: "back", name: "Insectile Aberration" }],
  selectedArtworkByFace: { front: firstArtwork, back: { ...firstArtwork, faceId: "back", candidateId: "scryfall:delver:back" } },
  backMode: "auto", backModeSelectionPolicy: "automatic",
});

describe("M6 artwork selection scopes", () => {
  it("requires the real candidate identity and face to match the requested card face", () => {
    const candidate: ArtworkCandidate = {
      id: "scryfall:printing:front", source: "scryfall", identityId: identity.id, faceId: "front", originalAvailable: true,
    };

    expect(() => validateArtworkCandidateForCard(card("target", 0), "front", { ...candidate, identityId: sameNameDifferentIdentity.id }))
      .toThrow(expect.objectContaining({ code: "INVALID_ARTWORK_IDENTITY" }));
    expect(() => validateArtworkCandidateForCard(dfc, "back", candidate))
      .toThrow(expect.objectContaining({ code: "INVALID_ARTWORK_IDENTITY" }));
    expect(() => validateArtworkCandidateForCard(dfc, "back", { ...candidate, identityId: sameNameDifferentIdentity.id, faceId: "back" }))
      .toThrow(expect.objectContaining({ code: "INVALID_ARTWORK_IDENTITY" }));
    expect(validateArtworkCandidateForCard(card("target", 0), "front", candidate)).toBe(candidate);
  });

  it("matches all equal cards by CardIdentity and face, never by display name", () => {
    const cards = [card("one", 0), card("same-identity", 1), card("same-name", 2, { identity: sameNameDifferentIdentity })];
    const next = applyArtworkSelectionScope({ cards, targetCardId: "one", faceId: "front", artwork: secondArtwork, scope: "same-identity" });

    expect(next.map((item) => item.selectedArtworkByFace.front?.candidateId)).toEqual([
      "scryfall:two:front", "scryfall:two:front", "scryfall:one:front",
    ]);
  });

  it("splits only the selected physical copy and preserves the expanded card sequence and card data", () => {
    const source = card("island-x4", 0, {
      quantity: 4,
      manualBackArtwork: { candidateId: "mpc:back:cardback", source: "mpc", identityId: null, faceId: "back", selectionPolicy: "user-selected" },
      metadata: { keep: "metadata" },
      mpcReferences: [{ faceId: "front", importedAssetId: "mpc-import", slots: ["front"], availableLocally: true }],
    });
    const next = applyArtworkSelectionScope({
      cards: [card("before", 0), { ...source, order: 1 }, card("after", 2)],
      targetCardId: source.id, faceId: "front", artwork: secondArtwork, scope: "physical-copy", physicalCardIndex: 2,
    });
    const nextPhysicalOrder = next.flatMap((item) => Array.from({ length: item.quantity }, () =>
      item.id === "before" || item.id === "after" ? item.id : item.selectedArtworkByFace.front?.candidateId));
    const selectedSegment = next.find((item) => item.selectedArtworkByFace.front?.candidateId === secondArtwork.candidateId)!;

    expect(next.map((item) => item.quantity)).toEqual([1, 1, 1, 2, 1]);
    expect(nextPhysicalOrder).toEqual(["before", "scryfall:one:front", "scryfall:two:front", "scryfall:one:front", "scryfall:one:front", "after"]);
    expect(selectedSegment).toMatchObject({ quantity: 1, metadata: source.metadata, manualBackArtwork: source.manualBackArtwork, mpcReferences: source.mpcReferences });
    expect(next.reduce((sum, item) => sum + item.quantity, 0)).toBe(6);
    expect(new Set(next.map((item) => item.id)).size).toBe(next.length);
  });

  it("requires the physical index to identify the exact WorkingCard supplied by the compositor", () => {
    expect(() => applyArtworkSelectionScope({
      cards: [card("one", 0), card("two", 1)], targetCardId: "one", faceId: "front", artwork: secondArtwork,
      scope: "physical-copy", physicalCardIndex: 1,
    })).toThrow(ArtworkSelectionScopeError);
  });

  it("keeps a M6 physical-copy split at its interleaved stable instance position", () => {
    const island = card("island-x4", 0, { quantity: 4 });
    const bolt = card("bolt", 1);
    const cards = [island, bolt];
    const initial = createPhysicalOrder(cards);
    const [one, two, three, four, boltInstance] = initial.instances;
    const physicalOrder = { ...initial, instances: [one!, boltInstance!, two!, three!, four!] };
    const result = applyArtworkSelectionScopeInPhysicalOrder({
      cards, physicalOrder, physicalInstanceId: three!.id,
      targetCardId: island.id, faceId: "front", artwork: secondArtwork, scope: "physical-copy",
    });

    expect(result.cards.map(({ quantity }) => quantity)).toEqual([3, 1, 1]);
    expect(result.physicalOrder.instances.map(({ id }) => id)).toEqual([one!.id, boltInstance!.id, two!.id, three!.id, four!.id]);
    expect(result.physicalOrder.instances.map(({ workingCardId }) => workingCardId)).toEqual([
      island.id, bolt.id, island.id, result.selectedCardId, island.id,
    ]);
    expect(result.cards.find(({ id }) => id === result.selectedCardId)?.selectedArtworkByFace.front?.candidateId).toBe(secondArtwork.candidateId);
  });

  it("keeps a generic-back physical-copy split attached to the same instance after interleaving", () => {
    const island = card("island-x3", 0, { quantity: 3 });
    const bolt = card("bolt", 1);
    const cards = [island, bolt];
    const initial = createPhysicalOrder(cards);
    const [one, two, three, boltInstance] = initial.instances;
    const physicalOrder = { ...initial, instances: [one!, boltInstance!, two!, three!] };
    const result = applyGenericBackScopeInPhysicalOrder({
      cards, physicalOrder, physicalInstanceId: two!.id,
      targetCardId: island.id, choice: { mode: "none" }, scope: "physical-copy",
    });

    expect(result.physicalOrder?.instances.map(({ id }) => id)).toEqual([one!.id, boltInstance!.id, two!.id, three!.id]);
    const selectedId = result.physicalOrder?.instances[2]?.workingCardId;
    expect(result.cards.find(({ id }) => id === selectedId)).toMatchObject({ quantity: 1, backMode: "none" });
    expect(result.cards.find(({ id }) => id === island.id)?.quantity).toBe(2);
  });

  it("applies bulk simple backs and reports preserved DFCs without changing their real back artwork", () => {
    const dfcBack = dfc.selectedArtworkByFace.back;
    const result = applyGenericBackScope({
      cards: [card("simple-one", 0, { quantity: 2 }), dfc, card("simple-two", 2)], targetCardId: "simple-one",
      choice: { mode: "none" }, scope: "all-simple-project",
    });

    expect(result).toMatchObject({ targetCardIds: ["simple-one", "simple-two"], affectedEntries: 2, affectedPhysicalCards: 3, preservedDfcEntries: 1, preservedDfcPhysicalCards: 1 });
    expect(result.cards[0]).toMatchObject({ backMode: "none", quantity: 2 });
    expect(result.cards[1]).toMatchObject({ backMode: "auto", selectedArtworkByFace: { back: dfcBack } });
    expect(result.cards[2]).toMatchObject({ backMode: "none" });
  });

  it("applies a simple back to all equal CardIdentity entries and excludes same-name identities and DFCs", () => {
    const result = applyGenericBackScope({
      cards: [card("same-one", 0, { quantity: 2 }), card("same-two", 1), card("same-name", 2, { identity: sameNameDifferentIdentity }), dfc],
      targetCardId: "same-one", choice: { mode: "none" }, scope: "same-identity",
    });

    expect(result.targetCardIds).toEqual(["same-one", "same-two"]);
    expect(result.affectedPhysicalCards).toBe(3);
    expect(result.cards.map((item) => item.backMode)).toEqual(["none", "none", "auto", "project-default"]);
    expect(result.cards[2]?.selectedArtworkByFace.back?.candidateId).toBe("scryfall:delver:back");
  });

  it("splits one physical copy for a generic back without changing its sequence position", () => {
    const result = applyGenericBackScope({
      cards: [card("before", 0), card("island-x3", 1, { quantity: 3 }), card("after", 2)],
      targetCardId: "island-x3", choice: { mode: "none" }, scope: "physical-copy", physicalCardIndex: 2,
    });
    const orderedModes = result.cards.flatMap((item) => Array.from({ length: item.quantity }, () => item.backMode));

    expect(result.cards.map((item) => item.quantity)).toEqual([1, 1, 1, 1, 1]);
    expect(orderedModes).toEqual(["project-default", "project-default", "none", "project-default", "project-default"]);
    expect(result.affectedPhysicalCards).toBe(1);
  });

  it("rejects direct generic-back operations whose selected target is a DFC", () => {
    for (const scope of ["entry", "same-identity", "all-simple-project"] as const) {
      expect(() => applyGenericBackScope({ cards: [dfc], targetCardId: "delver", choice: { mode: "none" }, scope })).toThrow(ArtworkSelectionScopeError);
    }
  });
});
