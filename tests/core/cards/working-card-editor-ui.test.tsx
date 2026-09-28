import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WorkingCardList, workingCardEditorReducer, type EditorUiState } from "../../../src/app/card-identity-workbench";
import { createWorkingCardEditorState } from "../../../core/cards/working-card-editor";
import type { WorkingCard } from "../../../core/cards/types";

const card: WorkingCard = {
  id: "sol-ring-working-card",
  quantity: 2,
  order: 0,
  importSource: { sourceId: "deck", importKind: "text", entryKind: "deck-card" },
  identityHints: { name: "Sol Ring" },
  identity: null,
  identityResolution: { status: "unresolved", candidates: [], confirmed: false },
  faces: [{ id: "front", side: "front", name: "Sol Ring" }],
  selectedArtworkByFace: { front: { candidateId: "scryfall:sol-ring", source: "scryfall", identityId: null, faceId: "front" } },
  localArtworkIds: [],
  mpcReferences: [],
  faceAssociations: [],
};

describe("working card editor list UI", () => {
  it("renders quantity, position, accessible reorder, duplicate, delete and drag controls", () => {
    const markup = renderToStaticMarkup(createElement(WorkingCardList, {
      cards: [card],
      selectedCardId: card.id,
      physicalCardCount: 2,
      disabled: false,
      onSelect: vi.fn(),
      onQuantityCommit: vi.fn(),
      onQuantityAdjust: vi.fn(),
      onMove: vi.fn(),
      onDuplicate: vi.fn(),
      onDelete: vi.fn(),
    }));

    expect(markup).toContain("1/1");
    expect(markup).toContain("Sol Ring");
    expect(markup).toContain("1 entrada · 2 cartas físicas");
    expect(markup).toContain('value="2"');
    expect(markup).toContain('aria-label="Mover Sol Ring para cima"');
    expect(markup).toContain('aria-label="Mover Sol Ring para baixo"');
    expect(markup).toContain('aria-label="Duplicar Sol Ring"');
    expect(markup).toContain('aria-label="Excluir Sol Ring"');
    expect(markup).toContain('draggable="true"');
  });

  it("preserves the active face when a duplicate supports it and falls back when it does not", () => {
    const frontArtwork = card.selectedArtworkByFace.front!;
    const doubleFaceCard: WorkingCard = {
      ...card,
      id: "delver-working-card",
      faces: [{ id: "front", side: "front", name: "Delver of Secrets" }, { id: "back", side: "back", name: "Insectile Aberration" }],
      selectedArtworkByFace: { front: frontArtwork, back: { candidateId: "delver-back", source: "scryfall", identityId: null, faceId: "back" } },
    };
    const initial = workingCardEditorReducer(
      { ...createWorkingCardEditorState([doubleFaceCard, card], doubleFaceCard.id), face: "front" },
      { type: "set-face", side: "back" },
    );

    const duplicateSingleFace = workingCardEditorReducer(initial, { type: "duplicate-card", cardId: card.id, newCardId: "single-clone" });
    const duplicateDoubleFace = workingCardEditorReducer(initial, { type: "duplicate-card", cardId: doubleFaceCard.id, newCardId: "double-clone" });

    expect(duplicateSingleFace.selectedCardId).toBe("single-clone");
    expect(duplicateSingleFace.face).toBe("front");
    expect(duplicateDoubleFace.selectedCardId).toBe("double-clone");
    expect(duplicateDoubleFace.face).toBe("back");
    const doubleFaceClone = duplicateDoubleFace.cards.find((item) => item.id === "double-clone");
    expect(doubleFaceClone).toMatchObject({
      quantity: doubleFaceCard.quantity,
      order: doubleFaceCard.order + 1,
      faces: doubleFaceCard.faces,
      selectedArtworkByFace: doubleFaceCard.selectedArtworkByFace,
    });
  });

  it("uses the available back face when loading a back-only card", () => {
    const backOnly: WorkingCard = {
      ...card,
      id: "back-only-card",
      faces: [{ id: "back", side: "back", name: "Back-only face" }],
      selectedArtworkByFace: { back: { candidateId: "back-only-art", source: "scryfall", identityId: null, faceId: "back" } },
    };

    const loaded = workingCardEditorReducer({ ...createWorkingCardEditorState([]), face: "front" }, { type: "load-cards", cards: [backOnly] });

    expect(loaded.selectedCardId).toBe(backOnly.id);
    expect(loaded.face).toBe("back");
  });

  it("defaults explicit selection and loading to front when that face is available", () => {
    const doubleFaceCard: WorkingCard = {
      ...card,
      id: "first-dfc",
      faces: [{ id: "front", side: "front", name: "Front" }, { id: "back", side: "back", name: "Back" }],
    };
    const otherDoubleFaceCard: WorkingCard = { ...doubleFaceCard, id: "second-dfc", order: 1 };
    const initial: EditorUiState = { ...createWorkingCardEditorState([doubleFaceCard, otherDoubleFaceCard]), face: "back" };

    const selected = workingCardEditorReducer(initial, { type: "select-card", cardId: otherDoubleFaceCard.id });
    const loaded = workingCardEditorReducer(initial, { type: "load-cards", cards: [otherDoubleFaceCard] });

    expect(selected.selectedCardId).toBe(otherDoubleFaceCard.id);
    expect(selected.face).toBe("front");
    expect(loaded.selectedCardId).toBe(otherDoubleFaceCard.id);
    expect(loaded.face).toBe("front");
  });

  it("falls back to an available face when replacing a card removes the active face", () => {
    const doubleFaceCard: WorkingCard = {
      ...card,
      faces: [{ id: "front", side: "front", name: "Delver of Secrets" }, { id: "back", side: "back", name: "Insectile Aberration" }],
    };
    const initial: EditorUiState = { ...createWorkingCardEditorState([doubleFaceCard]), face: "back" };

    const replaced = workingCardEditorReducer(initial, { type: "replace-card", cardId: card.id, card: { ...card, id: card.id } });

    expect(replaced.selectedCardId).toBe(card.id);
    expect(replaced.face).toBe("front");
  });

  it("keeps the active face when a replacement still supports it", () => {
    const doubleFaceCard: WorkingCard = {
      ...card,
      faces: [{ id: "front", side: "front", name: "Delver of Secrets" }, { id: "back", side: "back", name: "Insectile Aberration" }],
    };
    const initial: EditorUiState = { ...createWorkingCardEditorState([doubleFaceCard]), face: "back" };

    const replaced = workingCardEditorReducer(initial, {
      type: "replace-card",
      cardId: card.id,
      card: { ...doubleFaceCard, quantity: 4 },
    });

    expect(replaced.face).toBe("back");
    expect(replaced.cards[0]?.quantity).toBe(4);
  });

  it("falls back to a back-only face when replacing the active card", () => {
    const doubleFaceCard: WorkingCard = {
      ...card,
      faces: [{ id: "front", side: "front", name: "Front" }, { id: "back", side: "back", name: "Back" }],
    };
    const backOnlyCard: WorkingCard = {
      ...card,
      faces: [{ id: "back", side: "back", name: "Back-only face" }],
      selectedArtworkByFace: { back: { candidateId: "single-replacement-back-art", source: "scryfall", identityId: null, faceId: "back" } },
    };
    const initial: EditorUiState = { ...createWorkingCardEditorState([doubleFaceCard]), face: "front" };

    const replaced = workingCardEditorReducer(initial, { type: "replace-card", cardId: card.id, card: backOnlyCard });

    expect(replaced.selectedCardId).toBe(card.id);
    expect(replaced.face).toBe("back");
  });

  it("preserves or falls back from the active face when replacing all cards", () => {
    const doubleFaceCard: WorkingCard = {
      ...card,
      faces: [{ id: "front", side: "front", name: "Delver of Secrets" }, { id: "back", side: "back", name: "Insectile Aberration" }],
    };
    const otherCard: WorkingCard = { ...card, id: "other-card", order: 1 };
    const initial: EditorUiState = { ...createWorkingCardEditorState([doubleFaceCard, otherCard]), face: "back" };

    const preserved = workingCardEditorReducer(initial, {
      type: "replace-cards",
      cards: [{ ...doubleFaceCard, quantity: 4 }, otherCard],
    });
    const fallback = workingCardEditorReducer(initial, {
      type: "replace-cards",
      cards: [{ ...card }, otherCard],
    });

    expect(preserved.selectedCardId).toBe(card.id);
    expect(preserved.face).toBe("back");
    expect(preserved.cards[0]?.quantity).toBe(4);
    expect(fallback.selectedCardId).toBe(card.id);
    expect(fallback.face).toBe("front");
  });

  it("falls back to a back-only face when replacing all cards", () => {
    const doubleFaceCard: WorkingCard = {
      ...card,
      faces: [{ id: "front", side: "front", name: "Front" }, { id: "back", side: "back", name: "Back" }],
    };
    const backOnlyCard: WorkingCard = {
      ...card,
      faces: [{ id: "back", side: "back", name: "Back-only face" }],
      selectedArtworkByFace: { back: { candidateId: "back-only-art", source: "scryfall", identityId: null, faceId: "back" } },
    };
    const initial: EditorUiState = { ...createWorkingCardEditorState([doubleFaceCard]), face: "front" };

    const replaced = workingCardEditorReducer(initial, { type: "replace-cards", cards: [backOnlyCard] });

    expect(replaced.selectedCardId).toBe(card.id);
    expect(replaced.face).toBe("back");
  });

  it("falls back to an available face when the requested face is unavailable", () => {
    const backOnly: WorkingCard = {
      ...card,
      faces: [{ id: "back", side: "back", name: "Back-only face" }],
      selectedArtworkByFace: { back: { candidateId: "back-only-art", source: "scryfall", identityId: null, faceId: "back" } },
    };
    const frontOnlyState: EditorUiState = { ...createWorkingCardEditorState([card]), face: "front" };
    const backOnlyState: EditorUiState = { ...createWorkingCardEditorState([backOnly]), face: "back" };

    const frontFallback = workingCardEditorReducer(frontOnlyState, { type: "set-face", side: "back" });
    const backFallback = workingCardEditorReducer(backOnlyState, { type: "set-face", side: "front" });

    expect(frontFallback.face).toBe("front");
    expect(backFallback.face).toBe("back");
  });

  it("selects a valid face after deleting the active card", () => {
    const doubleFaceCard: WorkingCard = {
      ...card,
      id: "active-delver",
      faces: [{ id: "front", side: "front", name: "Delver of Secrets" }, { id: "back", side: "back", name: "Insectile Aberration" }],
    };
    const remainingCard: WorkingCard = { ...card, id: "remaining-card", order: 1 };
    const initial: EditorUiState = { ...createWorkingCardEditorState([doubleFaceCard, remainingCard], doubleFaceCard.id), face: "back" };

    const deleted = workingCardEditorReducer(initial, { type: "delete-card", cardId: doubleFaceCard.id });

    expect(deleted.selectedCardId).toBe(remainingCard.id);
    expect(deleted.face).toBe("front");
  });

  it("selects the available back face after deleting the active card", () => {
    const activeDoubleFaceCard: WorkingCard = {
      ...card,
      id: "active-delver",
      faces: [{ id: "front", side: "front", name: "Delver of Secrets" }, { id: "back", side: "back", name: "Insectile Aberration" }],
    };
    const remainingBackOnlyCard: WorkingCard = {
      ...card,
      id: "remaining-back-only-card",
      order: 1,
      faces: [{ id: "back", side: "back", name: "Back-only face" }],
      selectedArtworkByFace: { back: { candidateId: "remaining-back-art", source: "scryfall", identityId: null, faceId: "back" } },
    };
    const initial: EditorUiState = { ...createWorkingCardEditorState([activeDoubleFaceCard, remainingBackOnlyCard], activeDoubleFaceCard.id), face: "front" };

    const deleted = workingCardEditorReducer(initial, { type: "delete-card", cardId: activeDoubleFaceCard.id });

    expect(deleted.selectedCardId).toBe(remainingBackOnlyCard.id);
    expect(deleted.face).toBe("back");
  });

  it("preserves the active face when moving the selected card", () => {
    const doubleFaceCard: WorkingCard = {
      ...card,
      id: "active-delver",
      faces: [{ id: "front", side: "front", name: "Delver of Secrets" }, { id: "back", side: "back", name: "Insectile Aberration" }],
    };
    const otherCard: WorkingCard = { ...card, id: "other-card", order: 1 };
    const initial: EditorUiState = { ...createWorkingCardEditorState([doubleFaceCard, otherCard], doubleFaceCard.id), face: "back" };

    const moved = workingCardEditorReducer(initial, { type: "move-card", cardId: doubleFaceCard.id, targetIndex: 1 });

    expect(moved.selectedCardId).toBe(doubleFaceCard.id);
    expect(moved.cards.map((item) => item.id)).toEqual([otherCard.id, doubleFaceCard.id]);
    expect(moved.face).toBe("back");
  });

  it("preserves the active face when changing quantity", () => {
    const doubleFaceCard: WorkingCard = {
      ...card,
      faces: [{ id: "front", side: "front", name: "Delver of Secrets" }, { id: "back", side: "back", name: "Insectile Aberration" }],
    };
    const initial: EditorUiState = { ...createWorkingCardEditorState([doubleFaceCard]), face: "back" };

    const updated = workingCardEditorReducer(initial, { type: "set-quantity", cardId: card.id, quantity: 3 });

    expect(updated.cards[0]?.quantity).toBe(3);
    expect(updated.face).toBe("back");
  });
});
