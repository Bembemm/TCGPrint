import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { editorHistoryReducer, WorkingCardList, workingCardEditorReducer, type EditorUiState } from "../../../src/app/card-identity-workbench";
import * as workbenchModule from "../../../src/app/card-identity-workbench";
import { createWorkingCardEditorState } from "../../../core/cards/working-card-editor";
import { createEditorHistoryState } from "../../../core/cards/editor-history";
import { projectSnapshotKey } from "../../../src/app/project-session";
import { DEFAULT_PROJECT_SETTINGS } from "../../../persistence/projects/serializer";
import type { ArtworkCandidate, WorkingCard } from "../../../core/cards/types";
import type { ImportKind } from "../../../import-engine/types";

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
  backMode: "project-default",
  backModeSelectionPolicy: "automatic",
  localArtworkIds: [],
  mpcReferences: [],
  faceAssociations: [],
};

describe("working card editor list UI", () => {
  it("blocks selection, quantity, reorder, duplicate, and delete controls while locked", () => {
    const markup = renderToStaticMarkup(createElement(WorkingCardList, {
      cards: [card, { ...card, id: "second-card", order: 1 }],
      selectedCardId: card.id,
      physicalCardCount: 3,
      disabled: true,
      onSelect: vi.fn(),
      onQuantityCommit: vi.fn(),
      onQuantityAdjust: vi.fn(),
      onMove: vi.fn(),
      onDuplicate: vi.fn(),
      onDelete: vi.fn(),
    }));

    expect(markup).toMatch(/class="working-card-select"[^>]*disabled=""/);
    expect(markup).toMatch(/draggable="false"/);
    expect([...markup.matchAll(/aria-label="(?:Diminuir quantidade|Aumentar quantidade|Quantidade|Mover|Duplicar|Excluir)[^"]*"[^>]*disabled=""/g)]).toHaveLength(14);
  });

  it("shows one primary Add cards action without a global identity-resolution button", () => {
    const markup = renderToStaticMarkup(createElement(workbenchModule.default, { files: [], text: "", choices: {} }));

    expect(markup).toContain(">Adicionar cartas<");
    expect(markup).not.toContain(">Resolver identidades<");
  });

  it("announces semantic DFC identity in the main card list", () => {
    const dfc: WorkingCard = {
      ...card,
      identity: {
        id: "scryfall:oracle:dfc", provider: "scryfall", name: "Front // Back", resolutionMethod: "manual", confidence: 1,
        metadata: { layout: "transform", faces: [{ name: "Front" }, { name: "Back" }] },
      },
      faces: [{ id: "front", side: "front", name: "Front" }, { id: "back", side: "back", name: "Back" }],
      backMode: "auto",
    };
    const markup = renderToStaticMarkup(createElement(WorkingCardList, {
      cards: [dfc], selectedCardId: dfc.id, physicalCardCount: dfc.quantity, disabled: false,
      onSelect: vi.fn(), onQuantityCommit: vi.fn(), onQuantityAdjust: vi.fn(), onMove: vi.fn(), onDuplicate: vi.fn(), onDelete: vi.fn(),
    }));

    expect(markup).toContain('aria-label="Carta dupla-face"');
    expect(markup).toContain("Front // Back");
  });

  it("renders Card Details origin, imported hints, current identity, both artwork faces and manual mismatch text", () => {
    const detailed: WorkingCard = {
      ...card,
      section: "Mainboard",
      importSource: { sourceId: "decklist.txt", filename: "decklist.txt", importKind: "text", entryKind: "deck-card" },
      identityHints: { name: "Imported Island", setCode: "m21", collectorNumber: "265", language: "en", scryfallId: "hint-id" },
      identity: { id: "scryfall:oracle:island", provider: "scryfall", name: "Island // Island", setCode: "khm", collectorNumber: "145", lang: "ja", resolutionMethod: "manual", confidence: 0.94,
        metadata: { layout: "transform", faces: [{ name: "Island" }, { name: "Island Back" }] } },
      identityResolution: { status: "resolved", method: "manual", query: "Island", confidence: 0.94, confirmed: true, candidates: [] },
      faces: [{ id: "front", side: "front", name: "Island" }, { id: "back", side: "back", name: "Island Back" }],
      selectedArtworkByFace: {
        front: { candidateId: "scryfall:front-choice", source: "scryfall", identityId: "scryfall:oracle:previous", faceId: "front", selectionPolicy: "user-selected" },
        back: { candidateId: "mpc:back-choice", source: "mpc", identityId: "scryfall:oracle:island", faceId: "back", selectionPolicy: "newest-en-highres-nondigital-v1" },
      },
    };
    const Details = (workbenchModule as unknown as Record<string, unknown>).WorkingCardDetailsSummary as ComponentType<{
      card: WorkingCard;
      identityLayout?: string;
      artworkCandidates?: readonly ArtworkCandidate[];
    }> | undefined;
    expect(Details).toBeTypeOf("function");

    const markup = renderToStaticMarkup(createElement(Details!, {
      card: detailed,
      identityLayout: "transform",
      artworkCandidates: [{ id: "mpc:back-choice", source: "mpc", identityId: "scryfall:oracle:island", faceId: "back", originalAvailable: true, originalCached: true, effectiveDpi: 300 }],
    }));

    for (const text of ["Origem", "decklist.txt", "Tipo de import", "text", "Mainboard", "Hints importados", "Imported Island", "Set", "Collector", "Idioma", "EN", "M21", "Scryfall ID", "hint-id", "Identidade atual", "Island", "KHM", "145", "JA", "Provider", "scryfall", "Método de resolução", "manual", "Query", "Confiança", "94%", "Confirmada", "sim", "transform", "Carta dupla-face", "Artwork", "Front", "Back", "user-selected", "newest-en-highres-nondigital-v1", "Artwork escolhida manualmente para outra identidade.", "300 DPI", "Original validado no cache local"]) {
      expect(markup).toContain(text);
    }
    expect(markup).toContain("scryfall:front-choice");
    expect(markup).toContain("mpc:back-choice");

    const unverifiedMarkup = renderToStaticMarkup(createElement(Details!, {
      card: detailed,
      artworkCandidates: [{ id: "mpc:back-choice", source: "mpc", identityId: "scryfall:oracle:island", faceId: "back", originalAvailable: true }],
    }));
    expect(unverifiedMarkup).toContain("Original disponível no provider; cache local não verificado");
    expect(unverifiedMarkup).not.toContain("Original validado no cache local");
  });

  it("labels a provider artwork assigned as physical back without announcing a simple card as DFC", () => {
    const Details = (workbenchModule as unknown as Record<string, unknown>).WorkingCardDetailsSummary as ComponentType<{ card: WorkingCard }> | undefined;
    const simpleWithPhysicalBack: WorkingCard = {
      ...card,
      manualBackArtwork: {
        candidateId: "scryfall:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:front",
        source: "scryfall",
        identityId: "scryfall:oracle:sol-ring",
        faceId: "front",
        providerAssetId: "provider-printing",
        selectionPolicy: "user-selected",
      },
      backMode: "manual",
      backModeSelectionPolicy: "explicit",
    };
    const details = renderToStaticMarkup(createElement(Details!, { card: simpleWithPhysicalBack }));
    const list = renderToStaticMarkup(createElement(WorkingCardList, {
      cards: [simpleWithPhysicalBack], selectedCardId: simpleWithPhysicalBack.id, physicalCardCount: simpleWithPhysicalBack.quantity, disabled: false,
      onSelect: vi.fn(), onQuantityCommit: vi.fn(), onQuantityAdjust: vi.fn(), onMove: vi.fn(), onDuplicate: vi.fn(), onDelete: vi.fn(),
    }));

    expect(details).toContain("Verso físico manual");
    expect(details).toContain("provider-printing");
    expect(details).toContain("não cria uma face DFC");
    expect(details).not.toContain('aria-label="Carta dupla-face"');
    expect(list).toContain("Verso físico manual: Scryfall");
    expect(list).not.toContain('aria-label="Carta dupla-face"');
  });

  it("shows only the existing back face for a back-only WorkingCard", () => {
    const backOnly: WorkingCard = {
      ...card,
      identity: { id: "scryfall:oracle:back-only", provider: "scryfall", name: "Back-only", resolutionMethod: "manual", confidence: 1 },
      identityResolution: { status: "resolved", method: "manual", confirmed: true, candidates: [] },
      faces: [{ id: "back", side: "back", name: "Back-only" }],
      selectedArtworkByFace: { back: { candidateId: "scryfall:back-only", source: "scryfall", identityId: "scryfall:oracle:back-only", faceId: "back", selectionPolicy: "user-selected" } },
    };
    const Details = (workbenchModule as unknown as Record<string, unknown>).WorkingCardDetailsSummary as ComponentType<{
      card: WorkingCard;
    }> | undefined;
    expect(Details).toBeTypeOf("function");

    const markup = renderToStaticMarkup(createElement(Details!, { card: backOnly }));

    expect(markup).toContain("Artwork");
    expect(markup).toContain("Back-only");
    expect(markup).not.toContain("Front");
  });

  it("applies each per-card editorial result as one immutable replacement", () => {
    const doubleFaceCard: WorkingCard = {
      ...card,
      faces: [{ id: "front", side: "front", name: "Front" }, { id: "back", side: "back", name: "Back" }],
      selectedArtworkByFace: {
        front: { candidateId: "front-before", source: "scryfall", identityId: null, faceId: "front" },
        back: { candidateId: "back-before", source: "mpc", identityId: null, faceId: "back" },
      },
    };
    const otherCard = { ...card, id: "other-working-card", order: 1 };
    const initial: EditorUiState = { ...createWorkingCardEditorState([doubleFaceCard, otherCard], doubleFaceCard.id), face: "back" };
    const nextCard: WorkingCard = {
      ...doubleFaceCard,
      identity: { id: "manual:front", provider: "scryfall", name: "Chosen identity", resolutionMethod: "manual", confidence: 1 },
      identityResolution: { status: "resolved", method: "manual", confirmed: true, candidates: [] },
      selectedArtworkByFace: {
        front: { candidateId: "front-after", source: "scryfall", identityId: "manual:front", faceId: "front", selectionPolicy: "user-selected" },
        back: doubleFaceCard.selectedArtworkByFace.back,
      },
    };
    const actions = [
      { type: "apply-identity-result", cardId: doubleFaceCard.id, card: nextCard },
      { type: "apply-custom-result", cardId: doubleFaceCard.id, card: nextCard },
      { type: "apply-artwork-selection", cardId: doubleFaceCard.id, card: nextCard },
      { type: "apply-artwork-default", cardId: doubleFaceCard.id, card: nextCard },
      { type: "apply-reresolve-result", cardId: doubleFaceCard.id, card: nextCard },
    ];

    for (const action of actions) {
      const next = workingCardEditorReducer(initial, action as unknown as Parameters<typeof workingCardEditorReducer>[1]);
      expect(next).toMatchObject({ selectedCardId: doubleFaceCard.id, face: "back" });
      expect(next.cards[0]).toBe(nextCard);
      expect(next.cards[1]).toBe(otherCard);
      expect(next.cards).not.toBe(initial.cards);
    }
  });

  it("applies resolve-all as one grouped editorial result", () => {
    const otherCard: WorkingCard = { ...card, id: "other-working-card", order: 1 };
    const initial: EditorUiState = { ...createWorkingCardEditorState([card, otherCard]), face: "front" };
    const nextCards = [
      { ...card, identityResolution: { status: "resolved" as const, candidates: [], confirmed: false } },
      { ...otherCard, identityResolution: { status: "custom" as const, candidates: [], confirmed: true } },
    ];

    const next = workingCardEditorReducer(initial, { type: "apply-resolve-all-result", cards: nextCards } as unknown as Parameters<typeof workingCardEditorReducer>[1]);

    expect(next.cards).toEqual(nextCards);
    expect(next.cards).not.toBe(initial.cards);
    expect(next.selectedCardId).toBe(card.id);
  });

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

  it("renders compact accessible Undo and Redo controls disabled when history is empty", () => {
    const Workbench = workbenchModule.default as ComponentType<{
      files: readonly File[];
      text: string;
      choices: Readonly<Record<string, ImportKind>>;
    }>;
    const markup = renderToStaticMarkup(createElement(Workbench, { files: [], text: "", choices: {} }));

    expect(markup).toContain('role="group" aria-label="Histórico do editor"');
    expect(markup).toContain('aria-label="Desfazer" aria-keyshortcuts="Control+Z Meta+Z" disabled=""');
    expect(markup).toContain('aria-label="Refazer" aria-keyshortcuts="Control+Y Meta+Y Control+Shift+Z Meta+Shift+Z" disabled=""');
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

  it("undoes and redoes a quantity edit as one step", () => {
    const initial = createEditorHistoryState({ ...createWorkingCardEditorState([card]), face: "front" });
    const edited = editorHistoryReducer(initial, { type: "set-quantity", cardId: card.id, quantity: 4 });

    const undone = editorHistoryReducer(edited, { type: "undo" });
    const redone = editorHistoryReducer(undone, { type: "redo" });

    expect(edited.past).toHaveLength(1);
    expect(undone.present.cards[0]?.quantity).toBe(card.quantity);
    expect(redone.present.cards[0]?.quantity).toBe(4);
  });

  it("undoes and redoes a reorder through the same move-card command used by buttons and DnD", () => {
    const second: WorkingCard = { ...card, id: "second-card", order: 1 };
    const third: WorkingCard = { ...card, id: "third-card", order: 2 };
    const initial = createEditorHistoryState({ ...createWorkingCardEditorState([card, second, third]), face: "front" });
    const moved = editorHistoryReducer(initial, { type: "move-card", cardId: third.id, targetIndex: 0 });

    const undone = editorHistoryReducer(moved, { type: "undo" });
    const redone = editorHistoryReducer(undone, { type: "redo" });

    expect(moved.present.cards.map(({ id, order }) => [id, order])).toEqual([[third.id, 0], [card.id, 1], [second.id, 2]]);
    expect(undone.present.cards.map(({ id, order }) => [id, order])).toEqual([[card.id, 0], [second.id, 1], [third.id, 2]]);
    expect(redone.present.cards.map(({ id, order }) => [id, order])).toEqual([[third.id, 0], [card.id, 1], [second.id, 2]]);
  });

  it("undoes and redoes duplicate while restoring the same clone ID and selection", () => {
    const initial = createEditorHistoryState({ ...createWorkingCardEditorState([card]), face: "front" });
    const duplicated = editorHistoryReducer(initial, { type: "duplicate-card", cardId: card.id, newCardId: "stable-clone-id" });

    const undone = editorHistoryReducer(duplicated, { type: "undo" });
    const redone = editorHistoryReducer(undone, { type: "redo" });

    expect(undone.present.cards.map(({ id }) => id)).toEqual([card.id]);
    expect(undone.present.selectedCardId).toBe(card.id);
    expect(redone.present.cards.map(({ id }) => id)).toEqual([card.id, "stable-clone-id"]);
    expect(redone.present.selectedCardId).toBe("stable-clone-id");
  });

  it("restores a deleted active WorkingCard and its selection on undo", () => {
    const second: WorkingCard = { ...card, id: "second-card", order: 1 };
    const initial = createEditorHistoryState({
      ...createWorkingCardEditorState([card, second], second.id),
      face: "front",
    });
    const deleted = editorHistoryReducer(initial, { type: "delete-card", cardId: second.id });

    const undone = editorHistoryReducer(deleted, { type: "undo" });

    expect(undone.present.cards.map(({ id, order }) => [id, order])).toEqual([[card.id, 0], [second.id, 1]]);
    expect(undone.present.cards[1]).toBe(second);
    expect(undone.present.selectedCardId).toBe(second.id);
  });

  it("records resolve-all as one grouped undo step", () => {
    const second: WorkingCard = { ...card, id: "second-card", order: 1 };
    const initial = createEditorHistoryState({
      ...createWorkingCardEditorState([card, second]),
      face: "front",
    });
    const resolved = [
      { ...card, identityResolution: { status: "resolved" as const, candidates: [], confirmed: false } },
      { ...second, identityResolution: { status: "custom" as const, candidates: [], confirmed: true } },
    ];
    const edited = editorHistoryReducer(initial, { type: "apply-resolve-all-result", cards: resolved });

    expect(edited.past).toHaveLength(1);
    const undone = editorHistoryReducer(edited, { type: "undo" });
    expect(undone.present.cards).toEqual([card, second]);
  });

  it("undoes and redoes a manually confirmed identity without changing the WorkingCard ID", () => {
    const initial = createEditorHistoryState({ ...createWorkingCardEditorState([card]), face: "front" });
    const identity = { id: "manual:chosen", provider: "scryfall", name: "Chosen card", resolutionMethod: "manual" as const, confidence: 1 };
    const selected: WorkingCard = {
      ...card,
      identity,
      identityResolution: { status: "resolved", method: "manual", candidates: [], confirmed: true },
    };
    const confirmed = editorHistoryReducer(initial, { type: "apply-identity-result", cardId: card.id, card: selected });

    const undone = editorHistoryReducer(confirmed, { type: "undo" });
    const redone = editorHistoryReducer(undone, { type: "redo" });

    expect(undone.present.cards[0]).toBe(card);
    expect(redone.present.cards[0]).toEqual(selected);
    expect(redone.present.cards[0].id).toBe(card.id);
    expect(redone.present.cards[0].identity?.id).toBe(identity.id);
  });

  it("undoes and redoes Keep as custom as one editorial operation", () => {
    const initial = createEditorHistoryState({ ...createWorkingCardEditorState([card]), face: "front" });
    const custom: WorkingCard = {
      ...card,
      identity: null,
      identityResolution: { status: "custom", method: "custom", candidates: [], confirmed: true },
    };
    const edited = editorHistoryReducer(initial, { type: "apply-custom-result", cardId: card.id, card: custom });

    const undone = editorHistoryReducer(edited, { type: "undo" });
    const redone = editorHistoryReducer(undone, { type: "redo" });

    expect(undone.present.cards[0]).toBe(card);
    expect(redone.present.cards[0]).toEqual(custom);
    expect(edited.past).toHaveLength(1);
  });

  it("undoes and redoes a Front artwork choice without changing Back", () => {
    const backArtwork = { candidateId: "back-original", source: "mpc" as const, identityId: null, faceId: "back" as const };
    const doubleFace: WorkingCard = {
      ...card,
      faces: [{ id: "front", side: "front" }, { id: "back", side: "back" }],
      selectedArtworkByFace: { front: card.selectedArtworkByFace.front, back: backArtwork },
    };
    const initial = createEditorHistoryState({ ...createWorkingCardEditorState([doubleFace]), face: "front" });
    const updated: WorkingCard = {
      ...doubleFace,
      selectedArtworkByFace: {
        ...doubleFace.selectedArtworkByFace,
        front: { candidateId: "front-new", source: "upload", identityId: null, faceId: "front", selectionPolicy: "user-selected" },
      },
    };
    const edited = editorHistoryReducer(initial, { type: "apply-artwork-selection", cardId: doubleFace.id, card: updated });

    const undone = editorHistoryReducer(edited, { type: "undo" });
    const redone = editorHistoryReducer(undone, { type: "redo" });

    expect(undone.present.cards[0].selectedArtworkByFace.front).toEqual(doubleFace.selectedArtworkByFace.front);
    expect(undone.present.cards[0].selectedArtworkByFace.back).toBe(backArtwork);
    expect(redone.present.cards[0].selectedArtworkByFace.front?.candidateId).toBe("front-new");
    expect(redone.present.cards[0].selectedArtworkByFace.back).toBe(backArtwork);
  });

  it.each([
    { layout: "transform", frontName: "Delver of Secrets", backName: "Insectile Aberration" },
    { layout: "modal_dfc", frontName: "Bala Ged Recovery", backName: "Bala Ged Sanctuary" },
  ])("keeps Back artwork, Front artwork, and active face valid through undo/redo for $layout", ({ layout, frontName, backName }) => {
    const frontArtwork = { candidateId: "front-original", source: "scryfall" as const, identityId: "identity", faceId: "front" as const };
    const backArtwork = { candidateId: "back-original", source: "scryfall" as const, identityId: "identity", faceId: "back" as const };
    const doubleFace: WorkingCard = {
      ...card,
      identity: { id: "identity", provider: "scryfall", name: `${frontName} // ${backName}`, resolutionMethod: "manual", confidence: 1, metadata: { layout } },
      faces: [{ id: "front", side: "front", name: frontName }, { id: "back", side: "back", name: backName }],
      selectedArtworkByFace: { front: frontArtwork, back: backArtwork },
    };
    const initial = createEditorHistoryState({ ...createWorkingCardEditorState([doubleFace]), face: "front" });
    const onBack = editorHistoryReducer(initial, { type: "set-face", side: "back" });
    const updated: WorkingCard = {
      ...doubleFace,
      selectedArtworkByFace: {
        ...doubleFace.selectedArtworkByFace,
        back: { candidateId: "back-updated", source: "upload", identityId: "identity", faceId: "back", selectionPolicy: "user-selected" },
      },
    };
    const edited = editorHistoryReducer(onBack, { type: "apply-artwork-selection", cardId: doubleFace.id, card: updated });

    const undone = editorHistoryReducer(edited, { type: "undo" });
    expect(undone.present.face).toBe("back");
    expect(undone.present.cards[0].selectedArtworkByFace.back).toBe(backArtwork);
    expect(undone.present.cards[0].selectedArtworkByFace.front).toBe(frontArtwork);

    const redone = editorHistoryReducer(undone, { type: "redo" });
    expect(redone.present.face).toBe("back");
    expect(redone.present.cards[0].selectedArtworkByFace.back?.candidateId).toBe("back-updated");
    expect(redone.present.cards[0].selectedArtworkByFace.front).toBe(frontArtwork);
    expect(redone.present.cards[0].faces.some((face) => face.side === redone.present.face)).toBe(true);
  });

  it("undoes and redoes an explicit default artwork reset without changing the other face", () => {
    const selectedBack = { candidateId: "back-user-choice", source: "upload" as const, identityId: null, faceId: "back" as const, selectionPolicy: "user-selected" };
    const doubleFace: WorkingCard = {
      ...card,
      faces: [{ id: "front", side: "front" }, { id: "back", side: "back" }],
      selectedArtworkByFace: { front: card.selectedArtworkByFace.front, back: selectedBack },
    };
    const initial = createEditorHistoryState({ ...createWorkingCardEditorState([doubleFace]), face: "back" });
    const reset: WorkingCard = {
      ...doubleFace,
      selectedArtworkByFace: {
        ...doubleFace.selectedArtworkByFace,
        back: { candidateId: "back-default", source: "scryfall", identityId: null, faceId: "back", selectionPolicy: "newest-en-highres-nondigital-v1" },
      },
    };
    const edited = editorHistoryReducer(initial, { type: "apply-artwork-default", cardId: doubleFace.id, card: reset });

    const undone = editorHistoryReducer(edited, { type: "undo" });
    const redone = editorHistoryReducer(undone, { type: "redo" });

    expect(undone.present.cards[0].selectedArtworkByFace.back).toBe(selectedBack);
    expect(undone.present.cards[0].selectedArtworkByFace.front).toBe(doubleFace.selectedArtworkByFace.front);
    expect(redone.present.cards[0].selectedArtworkByFace.back?.candidateId).toBe("back-default");
    expect(redone.present.cards[0].selectedArtworkByFace.front).toBe(doubleFace.selectedArtworkByFace.front);
  });

  it("undoes and redoes a single-card re-resolve without another identity request", () => {
    const initial = createEditorHistoryState({ ...createWorkingCardEditorState([card]), face: "front" });
    const resolved: WorkingCard = {
      ...card,
      identity: { id: "resolved:identity", provider: "scryfall", name: "Resolved", resolutionMethod: "name", confidence: 0.9 },
      identityResolution: { status: "resolved", method: "name", candidates: [], confirmed: false },
    };
    const edited = editorHistoryReducer(initial, { type: "apply-reresolve-result", cardId: card.id, card: resolved });

    const undone = editorHistoryReducer(edited, { type: "undo" });
    const redone = editorHistoryReducer(undone, { type: "redo" });

    expect(undone.present.cards[0]).toBe(card);
    expect(redone.present.cards[0]).toEqual(resolved);
    expect(edited.past).toHaveLength(1);
  });

  it("does not record a no-op editorial result or discard an available Redo", () => {
    const initial = createEditorHistoryState({ ...createWorkingCardEditorState([card]), face: "front" });
    const edited = editorHistoryReducer(initial, { type: "set-quantity", cardId: card.id, quantity: 4 });
    const undone = editorHistoryReducer(edited, { type: "undo" });
    const noOp = editorHistoryReducer(undone, { type: "set-quantity", cardId: card.id, quantity: card.quantity });

    expect(noOp.past).toHaveLength(0);
    expect(noOp.future).toHaveLength(1);
    expect(editorHistoryReducer(noOp, { type: "redo" }).present.cards[0]?.quantity).toBe(4);
  });

  it("does not add history for selection or face navigation", () => {
    const doubleFace: WorkingCard = {
      ...card,
      faces: [{ id: "front", side: "front" }, { id: "back", side: "back" }],
    };
    const second: WorkingCard = { ...doubleFace, id: "second-card", order: 1 };
    const initial = createEditorHistoryState({
      ...createWorkingCardEditorState([doubleFace, second]),
      face: "front",
    });

    const selected = editorHistoryReducer(initial, { type: "select-card", cardId: second.id });
    const back = editorHistoryReducer(selected, { type: "set-face", side: "back" });

    expect(back.present).toMatchObject({ selectedCardId: second.id, face: "back" });
    expect(back.past).toHaveLength(0);
    expect(back.future).toHaveLength(0);
  });

  it("keeps Redo after a failed operation and clears it only after a new mutation", () => {
    const initial = createEditorHistoryState({ ...createWorkingCardEditorState([card]), face: "front" });
    const edited = editorHistoryReducer(initial, { type: "set-quantity", cardId: card.id, quantity: 3 });
    const undone = editorHistoryReducer(edited, { type: "undo" });
    const failed = editorHistoryReducer(undone, { type: "set-quantity", cardId: card.id, quantity: 0 });

    expect(failed.present.cards[0]?.quantity).toBe(card.quantity);
    expect(failed.future).toHaveLength(1);
    expect(failed.error).toMatch(/quantity/i);

    const changed = editorHistoryReducer(failed, { type: "set-quantity", cardId: card.id, quantity: 4 });
    expect(changed.future).toHaveLength(0);
    expect(editorHistoryReducer(changed, { type: "redo" })).toBe(changed);
  });

  it("allows face navigation after a failed edit without recording history", () => {
    const doubleFace: WorkingCard = {
      ...card,
      faces: [{ id: "front", side: "front" }, { id: "back", side: "back" }],
    };
    const initial = createEditorHistoryState({ ...createWorkingCardEditorState([doubleFace]), face: "front" });
    const failed = editorHistoryReducer(initial, { type: "set-quantity", cardId: doubleFace.id, quantity: 0 });

    expect(failed.error).toMatch(/quantity/i);
    const navigated = editorHistoryReducer(failed, { type: "set-face", side: "back" });

    expect(navigated.present.face).toBe("back");
    expect(navigated.error).toBeUndefined();
    expect(navigated.past).toHaveLength(0);
  });

  it("clears both history stacks when a new Working Set is loaded", () => {
    const initial = createEditorHistoryState({ ...createWorkingCardEditorState([card]), face: "front" });
    const edited = editorHistoryReducer(initial, { type: "set-quantity", cardId: card.id, quantity: 3 });
    const undone = editorHistoryReducer(edited, { type: "undo" });
    const imported: WorkingCard = { ...card, id: "new-import", order: 0 };

    const loaded = editorHistoryReducer(undone, { type: "load-cards", cards: [imported] });

    expect(loaded.present.cards.map(({ id }) => id)).toEqual([imported.id]);
    expect(loaded.past).toEqual([]);
    expect(loaded.future).toEqual([]);
  });

  it("opens persisted cards without sorting or rebasing order and resets selection and history", () => {
    const initial = createEditorHistoryState({ ...createWorkingCardEditorState([card]), face: "front" });
    const edited = editorHistoryReducer(initial, { type: "set-quantity", cardId: card.id, quantity: 3 });
    const editedAgain = editorHistoryReducer(edited, { type: "set-quantity", cardId: card.id, quantity: 4 });
    const withUndo = editorHistoryReducer(editedAgain, { type: "undo" });
    const persistedCards = [
      { ...card, id: "saved-second-in-array", order: 9, quantity: 2 },
      { ...card, id: "saved-first-by-order", order: 3, quantity: 1 },
    ];

    const loaded = editorHistoryReducer(withUndo, { type: "load-project", cards: persistedCards } as never);

    expect(loaded.present.cards).toEqual(persistedCards);
    expect(loaded.present.cards[0]).toBe(persistedCards[0]);
    expect(loaded.present.cards.map(({ id, order }) => [id, order])).toEqual([
      ["saved-second-in-array", 9],
      ["saved-first-by-order", 3],
    ]);
    expect(loaded.present.selectedCardId).toBe("saved-second-in-array");
    expect(loaded.present.face).toBe("front");
    expect(loaded.past).toEqual([]);
    expect(loaded.future).toEqual([]);
  });

  it("does not change persisted card values when only card selection and visible face change", () => {
    const persistedCards = [
      { ...card, id: "saved-first", order: 9, faces: [{ id: "front", side: "front" as const }, { id: "back", side: "back" as const }], selectedArtworkByFace: {} },
      { ...card, id: "saved-second", order: 3, faces: [{ id: "front", side: "front" as const }, { id: "back", side: "back" as const }], selectedArtworkByFace: {} },
    ];
    const loaded = editorHistoryReducer(
      createEditorHistoryState({ ...createWorkingCardEditorState([]), face: "front" }),
      { type: "load-project", cards: persistedCards } as never,
    );
    const selected = editorHistoryReducer(loaded, { type: "select-card", cardId: "saved-second" });
    const back = editorHistoryReducer(selected, { type: "set-face", side: "back" });

    expect(back.present.cards.map(({ id, order }) => [id, order])).toEqual([
      ["saved-first", 9],
      ["saved-second", 3],
    ]);
    expect(projectSnapshotKey(back.present.cards, DEFAULT_PROJECT_SETTINGS))
      .toBe(projectSnapshotKey(persistedCards, DEFAULT_PROJECT_SETTINGS));
    expect(back.present.selectedCardId).toBe("saved-second");
    expect(back.present.face).toBe("back");
  });

  it("preserves Undo and Redo state when loading invalid cards fails", () => {
    const initial = createEditorHistoryState({ ...createWorkingCardEditorState([card]), face: "front" });
    const edited = editorHistoryReducer(initial, { type: "set-quantity", cardId: card.id, quantity: 4 });
    const undone = editorHistoryReducer(edited, { type: "undo" });

    const failed = editorHistoryReducer(undone, { type: "load-cards", cards: [undefined as unknown as WorkingCard] });

    expect(failed.present).toBe(undone.present);
    expect(failed.past).toBe(undone.past);
    expect(failed.future).toBe(undone.future);
    expect(failed.error).toBeTruthy();
  });
});
