import { describe, expect, it } from "vitest";
import {
  MAX_PHYSICAL_CARDS_PER_EXPORT,
  createWorkingCardEditorState,
  deleteWorkingCard,
  duplicateWorkingCard,
  moveWorkingCard,
  normalizeWorkingCardOrder,
  setWorkingCardQuantity,
  type WorkingCardEditorState,
} from "../../../core/cards/working-card-editor";
import type { CardIdentity, SelectedArtwork, WorkingCard, WorkingCardMpcReference } from "../../../core/cards/types";

const identity: CardIdentity = {
  id: "scryfall:oracle:identity-a",
  provider: "scryfall",
  name: "Delver of Secrets // Insectile Aberration",
  oracleId: "identity-a",
  resolutionMethod: "manual",
  confidence: 1,
};
const frontArtwork: SelectedArtwork = { candidateId: "scryfall:front-art", source: "scryfall", identityId: identity.id, faceId: "front", selectionPolicy: "user-selected" };
const backArtwork: SelectedArtwork = { candidateId: "scryfall:back-art", source: "scryfall", identityId: identity.id, faceId: "back", selectionPolicy: "user-selected" };
const mpcReference: WorkingCardMpcReference = { faceId: "back", importedAssetId: "mpc-imported-back", providerAssetId: "mpc-provider-back", selectedArtworkId: "mpc-selected-back", slots: ["A1"], availableLocally: false };

function card(id: string, order: number, quantity = 1): WorkingCard {
  return {
    id,
    quantity,
    order,
    section: "Mainboard",
    importSource: { sourceId: `source-${id}`, filename: `${id}.png`, importKind: "text", entryKind: "deck-card" },
    identityHints: { name: identity.name, scryfallId: identity.scryfallId },
    identity,
    identityResolution: { status: "resolved", method: "manual", candidates: [], confirmed: true },
    faces: [{ id: "front", side: "front", name: "Delver of Secrets" }, { id: "back", side: "back", name: "Insectile Aberration" }],
    selectedArtworkByFace: { front: frontArtwork, back: backArtwork },
    localArtworkIds: ["upload:shared-original"],
    mpcReferences: [mpcReference],
    sharedMpcCardback: { importedAssetId: "shared-cardback", originalFormat: "png", availableLocally: true, provenance: { sourceId: "cardback-source" } },
    faceAssociations: [{ slot: "DFC", frontAssetId: "front-asset", backAssetId: "back-asset", accepted: true }],
    metadata: { imported: true },
  };
}

function state(cards: readonly WorkingCard[], selectedCardId = cards[0]?.id ?? null): WorkingCardEditorState {
  return createWorkingCardEditorState(cards, selectedCardId);
}

describe("working card editor operations", () => {
  it("normalizes imported order while retaining stable card IDs and selected artwork", () => {
    const cards = [card("third", 9), card("first", 0), card("second", 4)];
    const normalized = normalizeWorkingCardOrder(cards);

    expect(normalized.map(({ id, order }) => [id, order])).toEqual([["first", 0], ["second", 1], ["third", 2]]);
    expect(normalized.map(({ id }) => id)).toEqual(["first", "second", "third"]);
    expect(normalized[0].selectedArtworkByFace).toBe(cards[1].selectedArtworkByFace);
  });

  it("accepts quantity one and changes only the target entry", () => {
    const initial = state([card("a", 0, 2), card("b", 1, 1)], "b");
    const reduced = setWorkingCardQuantity(initial, "a", 1);
    const increased = setWorkingCardQuantity(reduced, "a", 3);

    expect(reduced.cards.map(({ id, quantity }) => [id, quantity])).toEqual([["a", 1], ["b", 1]]);
    expect(increased.cards.map(({ id, quantity }) => [id, quantity])).toEqual([["a", 3], ["b", 1]]);
    expect(increased.cards[0].id).toBe("a");
    expect(increased.cards[0].identity?.id).toBe(identity.id);
    expect(increased.cards[0].selectedArtworkByFace).toBe(initial.cards[0].selectedArtworkByFace);
    expect(increased.selectedCardId).toBe("b");
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid quantity %s", (quantity) => {
    expect(() => setWorkingCardQuantity(state([card("a", 0)]), "a", quantity)).toThrow(/integer.*at least 1/i);
  });

  it("uses the export cap as the maximum physical total and allows reducing an imported over-limit deck", () => {
    expect(MAX_PHYSICAL_CARDS_PER_EXPORT).toBe(500);
    const belowLimit = state([card("a", 0, 499)]);
    expect(setWorkingCardQuantity(belowLimit, "a", 500).cards[0].quantity).toBe(500);
    expect(() => setWorkingCardQuantity(belowLimit, "a", 501)).toThrow(/500/);

    const atLimit = state([card("a", 0, 499), card("b", 1, 1)]);
    expect(() => setWorkingCardQuantity(atLimit, "a", 500)).toThrow(/500/);

    const importedOverLimit = state([card("a", 0, 501), card("b", 1, 1)]);
    expect(() => setWorkingCardQuantity(importedOverLimit, "b", 2)).toThrow(/500/);
    expect(setWorkingCardQuantity(importedOverLimit, "a", 500).cards[0].quantity).toBe(500);
  });

  it("moves by ID in either direction and normalizes every resulting order", () => {
    const initial = state([card("a", 0), card("b", 1), card("c", 2)], "b");
    const lastToFirst = moveWorkingCard(state([card("a", 0), card("b", 1), card("c", 2)]), "c", 0);
    const firstToLast = moveWorkingCard(lastToFirst, "c", 2);
    const middleToMiddle = moveWorkingCard(initial, "b", 2);

    expect(lastToFirst.cards.map(({ id, order }) => [id, order])).toEqual([["c", 0], ["a", 1], ["b", 2]]);
    expect(firstToLast.cards.map(({ id, order }) => [id, order])).toEqual([["a", 0], ["b", 1], ["c", 2]]);
    expect(middleToMiddle.cards.map(({ id, order }) => [id, order])).toEqual([["a", 0], ["c", 1], ["b", 2]]);
    expect(middleToMiddle.selectedCardId).toBe("b");
    expect(middleToMiddle.cards.find(({ id }) => id === "b")?.identity?.id).toBe(identity.id);
  });

  it("treats the same target position as a no-op and rejects invalid reorder IDs or indexes", () => {
    const initial = state([card("a", 0), card("b", 1)], "b");
    expect(moveWorkingCard(initial, "b", 1)).toBe(initial);
    expect(() => moveWorkingCard(initial, "missing", 0)).toThrow(/not found/i);
    expect(() => moveWorkingCard(initial, "b", 2)).toThrow(/target index/i);
    expect(() => moveWorkingCard(initial, "b", 0.5)).toThrow(/target index/i);
  });

  it("duplicates a DFC as an independent WorkingCard immediately after the original", () => {
    const original = card("original", 0, 2);
    const other = card("other", 1);
    const duplicated = duplicateWorkingCard(state([original, other]), "original", "clone");
    const clone = duplicated.cards[1];

    expect(duplicated.cards.map(({ id, order }) => [id, order])).toEqual([["original", 0], ["clone", 1], ["other", 2]]);
    expect(duplicated.selectedCardId).toBe("clone");
    expect(clone.id).toBe("clone");
    expect(clone.identity?.id).toBe(original.identity?.id);
    expect(clone.quantity).toBe(original.quantity);
    expect(clone.section).toBe(original.section);
    expect(clone.importSource).toBe(original.importSource);
    expect(clone.identityHints).toBe(original.identityHints);
    expect(clone.identityResolution).toBe(original.identityResolution);
    expect(clone.faces).toBe(original.faces);
    expect(clone.selectedArtworkByFace).toEqual({ front: frontArtwork, back: backArtwork });
    expect(clone.localArtworkIds).toBe(original.localArtworkIds);
    expect(clone.mpcReferences).toEqual([mpcReference]);
    expect(clone.sharedMpcCardback).toBe(original.sharedMpcCardback);
    expect(clone.faceAssociations).toBe(original.faceAssociations);
    expect(clone.metadata).toBe(original.metadata);
    expect(clone).not.toBe(original);
  });

  it("rejects duplicate IDs and duplicates that exceed the physical export limit", () => {
    const initial = state([card("a", 0), card("b", 1)]);
    expect(() => duplicateWorkingCard(initial, "a", "b")).toThrow(/already exists/i);
    expect(() => duplicateWorkingCard(state([card("a", 0, 251), card("b", 1, 249)]), "a", "clone")).toThrow(/500/);
  });

  it("deletes one selected card and selects the next, or the previous when deleting the last", () => {
    const initial = state([card("a", 0), card("b", 1), card("c", 2)], "b");
    const afterMiddle = deleteWorkingCard(initial, "b");
    const afterLast = deleteWorkingCard(state([card("a", 0), card("b", 1)], "b"), "b");

    expect(afterMiddle.cards.map(({ id, order }) => [id, order])).toEqual([["a", 0], ["c", 1]]);
    expect(afterMiddle.selectedCardId).toBe("c");
    expect(afterLast.cards.map(({ id, order }) => [id, order])).toEqual([["a", 0]]);
    expect(afterLast.selectedCardId).toBe("a");
  });

  it("preserves another selected card, returns null for an empty set, and never mutates shared assets", () => {
    const sharedAssetIds = ["upload:shared-original"];
    const first = { ...card("a", 0), localArtworkIds: sharedAssetIds };
    const second = { ...card("b", 1), localArtworkIds: sharedAssetIds };
    const afterDelete = deleteWorkingCard(state([first, second], "b"), "a");
    const afterOnlyDelete = deleteWorkingCard(state([first], "a"), "a");

    expect(afterDelete.selectedCardId).toBe("b");
    expect(afterDelete.cards).toMatchObject([{ id: "b", order: 0 }]);
    expect(afterOnlyDelete).toMatchObject({ cards: [], selectedCardId: null });
    expect(sharedAssetIds).toEqual(["upload:shared-original"]);
    expect(afterDelete.cards[0].localArtworkIds).toBe(sharedAssetIds);
  });
});
