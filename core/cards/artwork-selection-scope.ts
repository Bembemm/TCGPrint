import { isDoubleFacedIdentity, isEligibleIdentityFaceSelection, selectManualBackArtwork, selectManualBackLibraryAsset, setWorkingCardBackMode } from "./back-selection";
import { normalizeWorkingCardOrder } from "./working-card-editor";
import { mpcArtworkCandidateId } from "./ids";
import { selectArtwork } from "./working-set";
import { replacePhysicalInstanceCard, validatePhysicalOrder, type PhysicalOrder } from "./physical-instance-order";
import type { ArtworkCandidate, BackLibraryAssetReference, CardFaceSide, SelectedArtwork, WorkingCard } from "./types";

export type ArtworkSelectionScope = "entry" | "physical-copy" | "same-identity";
export type GenericBackSelectionScope = ArtworkSelectionScope | "all-simple-project";

export class ArtworkSelectionScopeError extends Error {
  constructor(readonly code: "CARD_NOT_FOUND" | "INVALID_PHYSICAL_INDEX" | "IDENTITY_REQUIRED" | "FACE_NOT_AVAILABLE" | "INVALID_ARTWORK_IDENTITY" | "DFC_GENERIC_BACK" | "BACK_SELECTION_REQUIRED", message: string) {
    super(message);
    this.name = "ArtworkSelectionScopeError";
  }
}

export interface ApplyArtworkSelectionScopeInput {
  readonly cards: readonly WorkingCard[];
  readonly targetCardId: string;
  readonly faceId: CardFaceSide;
  readonly artwork: SelectedArtwork;
  readonly scope: ArtworkSelectionScope;
  /** Zero-based index in the expanded, ordered physical-card sequence. */
  readonly physicalCardIndex?: number;
}

export interface ApplyPhysicalArtworkSelectionScopeInput extends Omit<ApplyArtworkSelectionScopeInput, "physicalCardIndex"> {
  readonly physicalOrder: PhysicalOrder;
  readonly physicalInstanceId?: string;
}

export interface AppliedPhysicalArtworkSelectionScope {
  readonly cards: readonly WorkingCard[];
  readonly physicalOrder: PhysicalOrder;
  readonly selectedCardId: string;
}

export type GenericBackChoice =
  | { readonly mode: "none" | "project-default" }
  | { readonly mode: "library"; readonly asset: BackLibraryAssetReference }
  | { readonly mode: "mpc"; readonly candidate: ArtworkCandidate };

export interface ApplyGenericBackScopeInput {
  readonly cards: readonly WorkingCard[];
  readonly targetCardId: string;
  readonly choice: GenericBackChoice;
  readonly scope: GenericBackSelectionScope;
  readonly physicalCardIndex?: number;
}

export interface ApplyPhysicalGenericBackScopeInput extends Omit<ApplyGenericBackScopeInput, "physicalCardIndex"> {
  readonly physicalOrder: PhysicalOrder;
  readonly physicalInstanceId?: string;
}

export interface AppliedGenericBackScope {
  readonly cards: readonly WorkingCard[];
  readonly physicalOrder?: PhysicalOrder;
  readonly targetCardIds: readonly string[];
  readonly affectedEntries: number;
  readonly affectedPhysicalCards: number;
  readonly preservedDfcEntries: number;
  readonly preservedDfcPhysicalCards: number;
}

function identityKey(card: WorkingCard): string | null {
  return card.identity ? `${card.identity.provider}\u0000${card.identity.id}` : null;
}

function requireTarget(cards: readonly WorkingCard[], targetCardId: string): WorkingCard {
  const card = cards.find((item) => item.id === targetCardId);
  if (!card) throw new ArtworkSelectionScopeError("CARD_NOT_FOUND", `WorkingCard ${targetCardId} was not found.`);
  return card;
}

/** Checks the provider candidate itself before any selection code can bind it to a target. */
export function validateArtworkCandidateForCard(card: WorkingCard, faceId: CardFaceSide, candidate: ArtworkCandidate): ArtworkCandidate {
  const faceExists = card.faces.some((face) => face.side === faceId);
  const faceMatches = candidate.faceId === faceId;
  let identityMatches = candidate.identityId === card.identity?.id;
  if (!card.identity) {
    const sharedCustomCatalog = candidate.identityId === "custom:artwork-picker";
    const referencedMpcCandidate = candidate.source === "mpc"
      && candidate.identityId === "local:mpc-reference"
      && card.mpcReferences.some((reference) => reference.faceId === faceId
        && mpcArtworkCandidateId(reference.importedAssetId, reference.faceId) === candidate.id);
    identityMatches = candidate.identityId === null || sharedCustomCatalog || referencedMpcCandidate;
  }
  if (!faceExists || !faceMatches || !identityMatches) {
    throw new ArtworkSelectionScopeError("INVALID_ARTWORK_IDENTITY", "The artwork candidate's catalog identity and face must match the requested WorkingCard face.");
  }
  return candidate;
}

function physicalTargetIndex(cards: readonly WorkingCard[], targetCardId: string, physicalCardIndex: number | undefined): { cardIndex: number; copyIndex: number } {
  if (!Number.isSafeInteger(physicalCardIndex) || (physicalCardIndex ?? -1) < 0) {
    throw new ArtworkSelectionScopeError("INVALID_PHYSICAL_INDEX", "A physical-copy selection requires a non-negative zero-based physical card index.");
  }
  let start = 0;
  for (let cardIndex = 0; cardIndex < cards.length; cardIndex += 1) {
    const card = cards[cardIndex]!;
    const end = start + card.quantity;
    if (physicalCardIndex! >= start && physicalCardIndex! < end) {
      if (card.id !== targetCardId) throw new ArtworkSelectionScopeError("INVALID_PHYSICAL_INDEX", "Physical card index does not belong to the selected WorkingCard.");
      return { cardIndex, copyIndex: physicalCardIndex! - start };
    }
    start = end;
  }
  throw new ArtworkSelectionScopeError("INVALID_PHYSICAL_INDEX", "Physical card index is outside the ordered physical-card sequence.");
}

function stableSegmentId(cardId: string, physicalCardIndex: number, segment: "selected" | "after", existing: ReadonlySet<string>): string {
  const source = `${cardId}\u0000${physicalCardIndex}\u0000${segment}`;
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) hash = Math.imul(hash ^ source.charCodeAt(index), 16777619) >>> 0;
  const stem = `m6:${hash.toString(16).padStart(8, "0")}:${segment}`;
  let result = stem;
  let collision = 0;
  while (existing.has(result)) {
    collision += 1;
    result = `${stem}:${collision}`;
  }
  return result;
}

function splitPhysicalCard(cards: readonly WorkingCard[], targetCardId: string, physicalCardIndex: number): {
  readonly cards: readonly WorkingCard[];
  readonly cardIndex: number;
} {
  const { cardIndex, copyIndex } = physicalTargetIndex(cards, targetCardId, physicalCardIndex);
  const source = cards[cardIndex]!;
  const segments: WorkingCard[] = [];
  if (copyIndex > 0) segments.push({ ...source, quantity: copyIndex });
  const selectedId = copyIndex === 0 ? source.id : stableSegmentId(source.id, physicalCardIndex, "selected", new Set(cards.map((card) => card.id)));
  segments.push({ ...source, id: selectedId, quantity: 1 });
  const afterCount = source.quantity - copyIndex - 1;
  if (afterCount > 0) {
    const afterId = stableSegmentId(source.id, physicalCardIndex, "after", new Set([...cards.map((card) => card.id), selectedId]));
    segments.push({ ...source, id: afterId, quantity: afterCount });
  }
  const next = [...cards.slice(0, cardIndex), ...segments, ...cards.slice(cardIndex + 1)];
  const normalized = normalizeWorkingCardOrder(next);
  return { cards: normalized, cardIndex: normalized.findIndex((card) => card.id === selectedId) };
}

function validateArtworkTarget(card: WorkingCard, faceId: CardFaceSide, artwork: SelectedArtwork): void {
  if (!card.faces.some((face) => face.side === faceId) || !isEligibleIdentityFaceSelection(card, faceId)) {
    throw new ArtworkSelectionScopeError("FACE_NOT_AVAILABLE", `WorkingCard ${card.id} has no eligible ${faceId} identity face.`);
  }
  if (artwork.faceId !== faceId || (card.identity?.id ?? null) !== artwork.identityId) {
    throw new ArtworkSelectionScopeError("INVALID_ARTWORK_IDENTITY", "Artwork candidate identity and face must match the target WorkingCard.");
  }
}

function stablePhysicalSplitId(cardId: string, instanceId: string, existing: ReadonlySet<string>): string {
  const source = cardId + "\u0000" + instanceId;
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) hash = Math.imul(hash ^ source.charCodeAt(index), 16777619) >>> 0;
  const stem = "m7:copy:" + hash.toString(16).padStart(8, "0");
  let result = stem;
  let collision = 0;
  while (existing.has(result)) result = stem + ":" + (++collision);
  return result;
}

function splitPhysicalInstance(cards: readonly WorkingCard[], physicalOrder: PhysicalOrder, targetCardId: string, instanceId: string): {
  readonly cards: readonly WorkingCard[];
  readonly physicalOrder: PhysicalOrder;
  readonly selectedCardId: string;
} {
  const reference = physicalOrder.instances.find(({ id }) => id === instanceId);
  if (!reference || reference.workingCardId !== targetCardId) {
    throw new ArtworkSelectionScopeError("INVALID_PHYSICAL_INDEX", "Physical instance does not belong to the selected WorkingCard.");
  }
  const source = requireTarget(cards, targetCardId);
  if (source.quantity === 1) return { cards, physicalOrder, selectedCardId: source.id };
  const selectedId = stablePhysicalSplitId(source.id, instanceId, new Set(cards.map(({ id }) => id)));
  const next = cards.flatMap((card) => card.id === source.id
    ? [{ ...card, quantity: card.quantity - 1 }, { ...card, id: selectedId, quantity: 1 }]
    : [card]);
  const normalized = normalizeWorkingCardOrder(next);
  return {
    cards: normalized,
    physicalOrder: replacePhysicalInstanceCard(physicalOrder, instanceId, selectedId),
    selectedCardId: selectedId,
  };
}

/** Applies M6 scopes while preserving the canonical physical instance mapping through a one-copy split. */
export function applyArtworkSelectionScopeInPhysicalOrder(input: ApplyPhysicalArtworkSelectionScopeInput): AppliedPhysicalArtworkSelectionScope {
  const cards = normalizeWorkingCardOrder(input.cards);
  const physicalOrder = validatePhysicalOrder(cards, input.physicalOrder);
  const target = requireTarget(cards, input.targetCardId);
  validateArtworkTarget(target, input.faceId, input.artwork);
  if (input.scope === "physical-copy") {
    if (!input.physicalInstanceId) throw new ArtworkSelectionScopeError("INVALID_PHYSICAL_INDEX", "A physical-copy selection requires its stable instance ID.");
    const split = splitPhysicalInstance(cards, physicalOrder, target.id, input.physicalInstanceId);
    const updatedCards = split.cards.map((card) => card.id === split.selectedCardId ? selectArtwork(card, input.faceId, input.artwork) : card);
    return { cards: updatedCards, physicalOrder: validatePhysicalOrder(updatedCards, split.physicalOrder), selectedCardId: split.selectedCardId };
  }
  const updatedCards = applyArtworkSelectionScope({ ...input, cards });
  return { cards: updatedCards, physicalOrder, selectedCardId: target.id };
}

/** Applies one identity-face candidate at a semantic scope while preserving physical card order. */
export function applyArtworkSelectionScope(input: ApplyArtworkSelectionScopeInput): readonly WorkingCard[] {
  const cards = normalizeWorkingCardOrder(input.cards);
  const target = requireTarget(cards, input.targetCardId);
  validateArtworkTarget(target, input.faceId, input.artwork);

  if (input.scope === "physical-copy") {
    if (input.physicalCardIndex === undefined) throw new ArtworkSelectionScopeError("INVALID_PHYSICAL_INDEX", "A physical-copy selection requires its compositor index.");
    const split = splitPhysicalCard(cards, target.id, input.physicalCardIndex);
    return split.cards.map((card, index) => index === split.cardIndex ? selectArtwork(card, input.faceId, input.artwork) : card);
  }

  if (input.scope === "entry") {
    return cards.map((card) => card.id === target.id ? selectArtwork(card, input.faceId, input.artwork) : card);
  }

  const key = identityKey(target);
  if (!key) throw new ArtworkSelectionScopeError("IDENTITY_REQUIRED", "Applying artwork to equal cards requires a resolved CardIdentity.");
  return cards.map((card) => identityKey(card) === key && card.faces.some((face) => face.side === input.faceId)
    ? selectArtwork(card, input.faceId, input.artwork)
    : card);
}

function applyGenericBackChoice(card: WorkingCard, choice: GenericBackChoice): WorkingCard {
  if (isDoubleFacedIdentity(card.identity)) throw new ArtworkSelectionScopeError("DFC_GENERIC_BACK", "Generic bulk backs cannot change a double-faced card's real back face.");
  switch (choice.mode) {
    case "none": return setWorkingCardBackMode(card, "none");
    case "project-default": return setWorkingCardBackMode(card, "project-default");
    case "library": return selectManualBackLibraryAsset(card, choice.asset);
    case "mpc": return selectManualBackArtwork(card, choice.candidate);
  }
}

/** Generic physical-back policy. Project-wide actions skip and report DFCs; narrower DFC targets are rejected. */
export function applyGenericBackScope(input: ApplyGenericBackScopeInput): AppliedGenericBackScope {
  const cards = normalizeWorkingCardOrder(input.cards);
  const target = requireTarget(cards, input.targetCardId);
  if (isDoubleFacedIdentity(target.identity)) {
    throw new ArtworkSelectionScopeError("DFC_GENERIC_BACK", "A double-faced card's Back tab edits its real face and cannot use generic cardback actions.");
  }

  let targets: ReadonlySet<string>;
  let baseCards = cards;
  if (input.scope === "physical-copy") {
    if (input.physicalCardIndex === undefined) throw new ArtworkSelectionScopeError("INVALID_PHYSICAL_INDEX", "A physical-copy back selection requires its compositor index.");
    const split = splitPhysicalCard(cards, target.id, input.physicalCardIndex);
    baseCards = split.cards;
    targets = new Set([baseCards[split.cardIndex]!.id]);
  } else if (input.scope === "entry") {
    targets = new Set([target.id]);
  } else if (input.scope === "same-identity") {
    const key = identityKey(target);
    if (!key) throw new ArtworkSelectionScopeError("IDENTITY_REQUIRED", "Applying a back to equal cards requires a resolved CardIdentity.");
    targets = new Set(cards.filter((card) => identityKey(card) === key && !isDoubleFacedIdentity(card.identity)).map((card) => card.id));
  } else {
    targets = new Set(cards.filter((card) => !isDoubleFacedIdentity(card.identity)).map((card) => card.id));
  }

  const selected = baseCards.filter((card) => targets.has(card.id));
  const next = baseCards.map((card) => targets.has(card.id) ? applyGenericBackChoice(card, input.choice) : card);
  const preservedDfcs = input.scope === "all-simple-project"
    ? baseCards.filter((card) => isDoubleFacedIdentity(card.identity))
    : [];
  return {
    cards: normalizeWorkingCardOrder(next),
    targetCardIds: [...targets],
    affectedEntries: selected.length,
    affectedPhysicalCards: selected.reduce((sum, card) => sum + card.quantity, 0),
    preservedDfcEntries: preservedDfcs.length,
    preservedDfcPhysicalCards: preservedDfcs.reduce((sum, card) => sum + card.quantity, 0),
  };
}

/** Generic-back variant that splits exactly one stable physical instance without disturbing sequence. */
export function applyGenericBackScopeInPhysicalOrder(input: ApplyPhysicalGenericBackScopeInput): AppliedGenericBackScope {
  const cards = normalizeWorkingCardOrder(input.cards);
  const physicalOrder = validatePhysicalOrder(cards, input.physicalOrder);
  const target = requireTarget(cards, input.targetCardId);
  if (isDoubleFacedIdentity(target.identity)) {
    throw new ArtworkSelectionScopeError("DFC_GENERIC_BACK", "A double-faced card's Back tab edits its real face and cannot use generic cardback actions.");
  }
  if (input.scope !== "physical-copy") {
    return { ...applyGenericBackScope({ ...input, cards }), physicalOrder };
  }
  if (!input.physicalInstanceId) throw new ArtworkSelectionScopeError("INVALID_PHYSICAL_INDEX", "A physical-copy back selection requires its stable instance ID.");
  const split = splitPhysicalInstance(cards, physicalOrder, target.id, input.physicalInstanceId);
  const updatedCards = normalizeWorkingCardOrder(split.cards.map((card) => card.id === split.selectedCardId ? applyGenericBackChoice(card, input.choice) : card));
  return {
    cards: updatedCards,
    physicalOrder: validatePhysicalOrder(updatedCards, split.physicalOrder),
    targetCardIds: [split.selectedCardId],
    affectedEntries: 1,
    affectedPhysicalCards: 1,
    preservedDfcEntries: 0,
    preservedDfcPhysicalCards: 0,
  };
}
