import type { WorkingCard } from "./types";
import { MAX_PHYSICAL_CARDS_PER_EXPORT } from "./limits";
import {
  addPhysicalInstance,
  movePhysicalInstance,
  reconcilePhysicalOrder,
  removePhysicalInstance,
  type PhysicalOrder,
} from "./physical-instance-order";

export { MAX_PHYSICAL_CARDS_PER_EXPORT } from "./limits";

export interface WorkingCardEditorState {
  readonly cards: readonly WorkingCard[];
  readonly selectedCardId: string | null;
  readonly physicalOrder: PhysicalOrder;
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

function stateWithCards(state: WorkingCardEditorState, cards: readonly WorkingCard[], selectedCardId = state.selectedCardId, physicalOrder?: PhysicalOrder): WorkingCardEditorState {
  const normalized = normalizeWorkingCardOrder(cards);
  const selectionExists = selectedCardId !== null && normalized.some((card) => card.id === selectedCardId);
  return {
    cards: normalized,
    selectedCardId: selectionExists ? selectedCardId : normalized[0]?.id ?? null,
    physicalOrder: reconcilePhysicalOrder(normalized, physicalOrder ?? state.physicalOrder),
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

export function createWorkingCardEditorState(cards: readonly WorkingCard[], selectedCardId: string | null = cards[0]?.id ?? null, physicalOrder?: PhysicalOrder): WorkingCardEditorState {
  return stateWithCards({ cards, selectedCardId, physicalOrder: physicalOrder ?? reconcilePhysicalOrder(normalizeWorkingCardOrder(cards)) }, cards, selectedCardId, physicalOrder);
}

export function selectWorkingCard(state: WorkingCardEditorState, cardId: string): WorkingCardEditorState {
  const normalized = normalizeWorkingCardOrder(state.cards);
  if (!normalized.some((card) => card.id === cardId)) throw cardNotFound(cardId);
  return { cards: normalized, selectedCardId: cardId, physicalOrder: state.physicalOrder };
}

export function replaceWorkingCards(state: WorkingCardEditorState, cards: readonly WorkingCard[], physicalOrder?: PhysicalOrder): WorkingCardEditorState {
  return stateWithCards(state, cards, state.selectedCardId, physicalOrder);
}

export function replaceWorkingCard(state: WorkingCardEditorState, cardId: string, nextCard: WorkingCard, physicalOrder?: PhysicalOrder): WorkingCardEditorState {
  const normalized = normalizeWorkingCardOrder(state.cards);
  if (!normalized.some((card) => card.id === cardId)) throw cardNotFound(cardId);
  if (nextCard.id !== cardId) {
    throw new WorkingCardEditorError("CARD_ID_MISMATCH", "Replacing a WorkingCard must preserve its existing ID.");
  }
  return stateWithCards(state, normalized.map((card) => card.id === cardId ? nextCard : card), state.selectedCardId, physicalOrder);
}

export function setWorkingCardQuantity(state: WorkingCardEditorState, cardId: string, quantity: number): WorkingCardEditorState {
  const cards = normalizeWorkingCardOrder(state.cards);
  const card = cards.find((item) => item.id === cardId);
  if (!card) throw cardNotFound(cardId);
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    throw new WorkingCardEditorError("INVALID_QUANTITY", "Quantity must be an integer of at least 1.");
  }
  if (quantity === card.quantity) return { cards, selectedCardId: state.selectedCardId, physicalOrder: state.physicalOrder };

  const physicalTotal = cards.reduce((sum, item) => sum + item.quantity, 0);
  const nextPhysicalTotal = physicalTotal - card.quantity + quantity;
  if (nextPhysicalTotal > MAX_PHYSICAL_CARDS_PER_EXPORT && quantity > card.quantity) {
    throw new WorkingCardEditorError("EXPORT_LIMIT_EXCEEDED", `The editor cannot increase the deck beyond ${MAX_PHYSICAL_CARDS_PER_EXPORT} physical cards per PDF.`);
  }

  return stateWithCards(state, cards.map((item) => item.id === cardId ? { ...item, quantity } : item));
}

/** Removes exactly one selected physical copy; other copies keep their IDs and relative sequence. */
export function removeWorkingCardPhysicalInstance(state: WorkingCardEditorState, instanceId: string): WorkingCardEditorState {
  const reference = state.physicalOrder.instances.find(({ id }) => id === instanceId);
  if (!reference) throw new WorkingCardEditorError("CARD_NOT_FOUND", `Physical instance ${instanceId} was not found.`);
  const card = state.cards.find(({ id }) => id === reference.workingCardId);
  if (!card) throw cardNotFound(reference.workingCardId);
  if (card.quantity === 1) return deleteWorkingCard(state, card.id);
  const removed = removePhysicalInstance(state.physicalOrder, instanceId);
  return stateWithCards(state, state.cards.map((item) => item.id === card.id ? { ...item, quantity: item.quantity - 1 } : item), state.selectedCardId, removed.order);
}

/** Reorders one physical copy by insertion, without expanding or splitting its WorkingCard. */
export function reorderWorkingCardPhysicalInstance(
  state: WorkingCardEditorState,
  instanceId: string,
  targetInstanceId: string | null,
  placement: "before" | "after" = "after",
): WorkingCardEditorState {
  const physicalOrder = movePhysicalInstance(state.physicalOrder, instanceId, targetInstanceId, placement);
  return { ...state, physicalOrder };
}

export function moveWorkingCard(state: WorkingCardEditorState, cardId: string, targetIndex: number): WorkingCardEditorState {
  const cards = normalizeWorkingCardOrder(state.cards);
  const currentIndex = cards.findIndex((card) => card.id === cardId);
  if (currentIndex < 0) throw cardNotFound(cardId);
  if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= cards.length) {
    throw new WorkingCardEditorError("INVALID_TARGET_INDEX", `Target index must be an integer between 0 and ${cards.length - 1}.`);
  }
  if (currentIndex === targetIndex && cards === state.cards) return state;
  if (currentIndex === targetIndex) return { cards, selectedCardId: state.selectedCardId, physicalOrder: state.physicalOrder };

  const reordered = [...cards];
  const [moved] = reordered.splice(currentIndex, 1);
  reordered.splice(targetIndex, 0, moved);
  const movedCards = reordered.map((card, order) => card.order === order ? card : { ...card, order });
  const movedOrder = { ...state.physicalOrder, instances: [...state.physicalOrder.instances] };
  const movingRefs = movedOrder.instances.filter(({ workingCardId }) => workingCardId === cardId);
  const remainingRefs = movedOrder.instances.filter(({ workingCardId }) => workingCardId !== cardId);
  const nextCardId = movedCards[targetIndex + 1]?.id;
  const insertionIndex = nextCardId === undefined
    ? remainingRefs.length
    : Math.max(0, remainingRefs.findIndex(({ workingCardId }) => workingCardId === nextCardId));
  const nextPhysicalOrder = { ...movedOrder, instances: [...remainingRefs.slice(0, insertionIndex), ...movingRefs, ...remainingRefs.slice(insertionIndex)] };
  return stateWithCards(state, movedCards, state.selectedCardId, nextPhysicalOrder);
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
  let physicalOrder = state.physicalOrder;
  let lastOriginalIndex = physicalOrder.instances.reduce((last, item, index) => item.workingCardId === cardId ? index : last, -1);
  for (let copy = 0; copy < original.quantity; copy += 1) {
    const added = addPhysicalInstance(physicalOrder, newCardId, lastOriginalIndex);
    physicalOrder = added.order;
    lastOriginalIndex = physicalOrder.instances.findIndex(({ id }) => id === added.instance.id);
  }
  return stateWithCards(state, nextCards, newCardId, physicalOrder);
}

/** Copies only the selected physical instance into a new quantity-one entry immediately after it in physical order. */
export function duplicatePhysicalInstanceAsEntry(state: WorkingCardEditorState, instanceId: string, newCardId: string): WorkingCardEditorState {
  const physicalIndex = state.physicalOrder.instances.findIndex(({ id }) => id === instanceId);
  if (physicalIndex < 0) throw new WorkingCardEditorError("CARD_NOT_FOUND", `Physical instance ${instanceId} was not found.`);
  if (!newCardId.trim() || state.cards.some((card) => card.id === newCardId)) {
    throw new WorkingCardEditorError("DUPLICATE_ID", `WorkingCard ID ${newCardId} is empty or already exists.`);
  }
  if (state.physicalOrder.instances.length >= MAX_PHYSICAL_CARDS_PER_EXPORT) {
    throw new WorkingCardEditorError("EXPORT_LIMIT_EXCEEDED", `Duplicating a physical instance would exceed ${MAX_PHYSICAL_CARDS_PER_EXPORT} physical cards per PDF.`);
  }
  const reference = state.physicalOrder.instances[physicalIndex]!;
  const sourceIndex = state.cards.findIndex((card) => card.id === reference.workingCardId);
  const source = state.cards[sourceIndex];
  if (!source) throw cardNotFound(reference.workingCardId);
  const clone = { ...source, id: newCardId, quantity: 1 };
  const nextCards = [...state.cards];
  nextCards.splice(sourceIndex + 1, 0, clone);
  const added = addPhysicalInstance(state.physicalOrder, newCardId, physicalIndex);
  return stateWithCards(state, nextCards, newCardId, added.order);
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
