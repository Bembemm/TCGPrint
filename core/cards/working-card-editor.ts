import type { WorkingCard } from "./types";
import { MAX_PHYSICAL_CARDS_PER_EXPORT } from "./limits";

export { MAX_PHYSICAL_CARDS_PER_EXPORT } from "./limits";

export interface WorkingCardEditorState {
  readonly cards: readonly WorkingCard[];
  readonly selectedCardId: string | null;
}

export class WorkingCardEditorError extends Error {
  constructor(readonly code: "CARD_NOT_FOUND" | "INVALID_QUANTITY" | "EXPORT_LIMIT_EXCEEDED" | "INVALID_TARGET_INDEX" | "DUPLICATE_ID" | "CARD_ID_MISMATCH", message: string) {
    super(message);
    this.name = "WorkingCardEditorError";
  }
}

function cardNotFound(cardId: string): WorkingCardEditorError {
  return new WorkingCardEditorError("CARD_NOT_FOUND", `WorkingCard ${cardId} was not found.`);
}

function stateWithCards(state: WorkingCardEditorState, cards: readonly WorkingCard[], selectedCardId = state.selectedCardId): WorkingCardEditorState {
  const normalized = normalizeWorkingCardOrder(cards);
  const selectionExists = selectedCardId !== null && normalized.some((card) => card.id === selectedCardId);
  return {
    cards: normalized,
    selectedCardId: selectionExists ? selectedCardId : normalized[0]?.id ?? null,
  };
}

export function normalizeWorkingCardOrder(cards: readonly WorkingCard[]): readonly WorkingCard[] {
  const ordered = cards
    .map((card, index) => ({ card, index }))
    .sort((left, right) => left.card.order - right.card.order || left.index - right.index);
  const alreadyNormalized = ordered.every(({ card, index }, order) => index === order && card.order === order);
  if (alreadyNormalized) return cards;
  return ordered.map(({ card }, order) => card.order === order ? card : { ...card, order });
}

export function createWorkingCardEditorState(cards: readonly WorkingCard[], selectedCardId: string | null = cards[0]?.id ?? null): WorkingCardEditorState {
  return stateWithCards({ cards, selectedCardId }, cards, selectedCardId);
}

export function selectWorkingCard(state: WorkingCardEditorState, cardId: string): WorkingCardEditorState {
  const normalized = normalizeWorkingCardOrder(state.cards);
  if (!normalized.some((card) => card.id === cardId)) throw cardNotFound(cardId);
  return { cards: normalized, selectedCardId: cardId };
}

export function replaceWorkingCards(state: WorkingCardEditorState, cards: readonly WorkingCard[]): WorkingCardEditorState {
  return stateWithCards(state, cards);
}

export function replaceWorkingCard(state: WorkingCardEditorState, cardId: string, nextCard: WorkingCard): WorkingCardEditorState {
  const normalized = normalizeWorkingCardOrder(state.cards);
  if (!normalized.some((card) => card.id === cardId)) throw cardNotFound(cardId);
  if (nextCard.id !== cardId) {
    throw new WorkingCardEditorError("CARD_ID_MISMATCH", "Replacing a WorkingCard must preserve its existing ID.");
  }
  return stateWithCards(state, normalized.map((card) => card.id === cardId ? nextCard : card));
}

export function setWorkingCardQuantity(state: WorkingCardEditorState, cardId: string, quantity: number): WorkingCardEditorState {
  const cards = normalizeWorkingCardOrder(state.cards);
  const card = cards.find((item) => item.id === cardId);
  if (!card) throw cardNotFound(cardId);
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    throw new WorkingCardEditorError("INVALID_QUANTITY", "Quantity must be an integer of at least 1.");
  }
  if (quantity === card.quantity) return { cards, selectedCardId: state.selectedCardId };

  const physicalTotal = cards.reduce((sum, item) => sum + item.quantity, 0);
  const nextPhysicalTotal = physicalTotal - card.quantity + quantity;
  if (nextPhysicalTotal > MAX_PHYSICAL_CARDS_PER_EXPORT && quantity > card.quantity) {
    throw new WorkingCardEditorError("EXPORT_LIMIT_EXCEEDED", `The editor cannot increase the deck beyond ${MAX_PHYSICAL_CARDS_PER_EXPORT} physical cards per PDF.`);
  }

  return stateWithCards(state, cards.map((item) => item.id === cardId ? { ...item, quantity } : item));
}

export function moveWorkingCard(state: WorkingCardEditorState, cardId: string, targetIndex: number): WorkingCardEditorState {
  const cards = normalizeWorkingCardOrder(state.cards);
  const currentIndex = cards.findIndex((card) => card.id === cardId);
  if (currentIndex < 0) throw cardNotFound(cardId);
  if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= cards.length) {
    throw new WorkingCardEditorError("INVALID_TARGET_INDEX", `Target index must be an integer between 0 and ${cards.length - 1}.`);
  }
  if (currentIndex === targetIndex && cards === state.cards) return state;
  if (currentIndex === targetIndex) return { cards, selectedCardId: state.selectedCardId };

  const reordered = [...cards];
  const [moved] = reordered.splice(currentIndex, 1);
  reordered.splice(targetIndex, 0, moved);
  const movedCards = reordered.map((card, order) => card.order === order ? card : { ...card, order });
  return stateWithCards(state, movedCards);
}

export function duplicateWorkingCard(state: WorkingCardEditorState, cardId: string, newCardId: string): WorkingCardEditorState {
  const cards = normalizeWorkingCardOrder(state.cards);
  const originalIndex = cards.findIndex((card) => card.id === cardId);
  if (originalIndex < 0) throw cardNotFound(cardId);
  if (!newCardId.trim() || cards.some((card) => card.id === newCardId)) {
    throw new WorkingCardEditorError("DUPLICATE_ID", `WorkingCard ID ${newCardId} is empty or already exists.`);
  }

  const original = cards[originalIndex];
  const physicalTotal = cards.reduce((sum, item) => sum + item.quantity, 0);
  if (physicalTotal + original.quantity > MAX_PHYSICAL_CARDS_PER_EXPORT) {
    throw new WorkingCardEditorError("EXPORT_LIMIT_EXCEEDED", `Duplicating this entry would exceed ${MAX_PHYSICAL_CARDS_PER_EXPORT} physical cards per PDF.`);
  }

  const clone: WorkingCard = { ...original, id: newCardId };
  const nextCards = [...cards];
  nextCards.splice(originalIndex + 1, 0, clone);
  return stateWithCards(state, nextCards, newCardId);
}

export function deleteWorkingCard(state: WorkingCardEditorState, cardId: string): WorkingCardEditorState {
  const cards = normalizeWorkingCardOrder(state.cards);
  const deleteIndex = cards.findIndex((card) => card.id === cardId);
  if (deleteIndex < 0) throw cardNotFound(cardId);
  const nextCards = cards.filter((card) => card.id !== cardId);

  let selectedCardId = state.selectedCardId;
  if (selectedCardId === cardId) {
    selectedCardId = nextCards[deleteIndex]?.id ?? nextCards[deleteIndex - 1]?.id ?? null;
  }
  return stateWithCards(state, nextCards, selectedCardId);
}
