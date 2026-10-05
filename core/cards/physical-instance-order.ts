import type { WorkingCard } from "./types";
import { MAX_PHYSICAL_CARDS_PER_EXPORT } from "./limits";

export interface PhysicalInstanceReference {
  readonly id: string;
  readonly workingCardId: string;
}

/** Durable physical sequence. Artwork and card data remain on WorkingCard. */
export interface PhysicalOrder {
  readonly nextInstanceId: number;
  readonly instances: readonly PhysicalInstanceReference[];
}

export class PhysicalOrderError extends Error {
  constructor(readonly code: "INVALID_PHYSICAL_ORDER" | "INVALID_PHYSICAL_INSTANCE_ID" | "PHYSICAL_INSTANCE_NOT_FOUND" | "EXPORT_LIMIT_EXCEEDED", message: string) {
    super(message);
    this.name = "PhysicalOrderError";
  }
}

type OrderedCard = Pick<WorkingCard, "id" | "quantity" | "order">;

function ordered(cards: readonly OrderedCard[]): readonly OrderedCard[] {
  return cards.map((card, index) => ({ card, index }))
    .sort((left, right) => left.card.order - right.card.order || left.index - right.index)
    .map(({ card }) => card);
}

function cardMap(cards: readonly OrderedCard[], enforceExportLimit = true): Map<string, OrderedCard> {
  const map = new Map<string, OrderedCard>();
  let total = 0;
  for (const card of cards) {
    if (!card.id || map.has(card.id) || !Number.isSafeInteger(card.quantity) || card.quantity < 1 || !Number.isSafeInteger(card.order) || card.order < 0) {
      throw new PhysicalOrderError("INVALID_PHYSICAL_ORDER", "Physical order requires unique WorkingCards with positive integer quantities and valid logical order.");
    }
    map.set(card.id, card);
    total += card.quantity;
  }
  if (enforceExportLimit && total > MAX_PHYSICAL_CARDS_PER_EXPORT) {
    throw new PhysicalOrderError("EXPORT_LIMIT_EXCEEDED", "A Project cannot contain more than " + MAX_PHYSICAL_CARDS_PER_EXPORT + " physical cards.");
  }
  return map;
}

function newReference(nextInstanceId: number, workingCardId: string): PhysicalInstanceReference {
  if (!Number.isSafeInteger(nextInstanceId) || nextInstanceId < 1) {
    throw new PhysicalOrderError("INVALID_PHYSICAL_ORDER", "The next physical instance ID must be a positive safe integer.");
  }
  return { id: "instance-" + nextInstanceId, workingCardId };
}

/** Deterministic legacy order: logical order, then each WorkingCard's compact quantity. */
export function createPhysicalOrder(cards: readonly OrderedCard[]): PhysicalOrder {
  const byId = cardMap(cards, false);
  const instances: PhysicalInstanceReference[] = [];
  let nextInstanceId = 1;
  for (const card of ordered(cards)) {
    for (let copy = 0; copy < card.quantity; copy += 1) {
      instances.push(newReference(nextInstanceId++, card.id));
    }
  }
  if (instances.length !== [...byId.values()].reduce((sum, card) => sum + card.quantity, 0)) {
    throw new PhysicalOrderError("INVALID_PHYSICAL_ORDER", "Physical order could not be initialized from WorkingCards.");
  }
  return { nextInstanceId, instances };
}

/** Validates exact one-to-one quantity coverage at persistence and service boundaries. */
export function validatePhysicalOrder(cards: readonly OrderedCard[], value: unknown): PhysicalOrder {
  const byId = cardMap(cards);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PhysicalOrderError("INVALID_PHYSICAL_ORDER", "Physical order must be an object.");
  }
  const source = value as { nextInstanceId?: unknown; instances?: unknown };
  if (!Number.isSafeInteger(source.nextInstanceId) || (source.nextInstanceId as number) < 1 || !Array.isArray(source.instances)) {
    throw new PhysicalOrderError("INVALID_PHYSICAL_ORDER", "Physical order must contain a nextInstanceId and an instances array.");
  }
  if (source.instances.length !== [...byId.values()].reduce((sum, card) => sum + card.quantity, 0)
    || source.instances.length > MAX_PHYSICAL_CARDS_PER_EXPORT) {
    throw new PhysicalOrderError("INVALID_PHYSICAL_ORDER", "Physical instance references must match WorkingCard quantities exactly.");
  }
  const ids = new Set<string>();
  const counts = new Map<string, number>();
  let maxId = 0;
  const instances = source.instances.map((value, index): PhysicalInstanceReference => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new PhysicalOrderError("INVALID_PHYSICAL_ORDER", "Physical instance " + index + " must be an object.");
    }
    const instance = value as { id?: unknown; workingCardId?: unknown };
    if (typeof instance.id !== "string" || !/^instance-[1-9][0-9]{0,15}$/.test(instance.id) || instance.id.length > 32) {
      throw new PhysicalOrderError("INVALID_PHYSICAL_INSTANCE_ID", "Physical instance ID at index " + index + " is malformed.");
    }
    const sequence = Number(instance.id.slice("instance-".length));
    if (!Number.isSafeInteger(sequence)) throw new PhysicalOrderError("INVALID_PHYSICAL_INSTANCE_ID", "Physical instance ID at index " + index + " is malformed.");
    if (ids.has(instance.id)) throw new PhysicalOrderError("INVALID_PHYSICAL_ORDER", "Physical instance ID " + instance.id + " is duplicated.");
    ids.add(instance.id);
    maxId = Math.max(maxId, sequence);
    if (typeof instance.workingCardId !== "string" || !byId.has(instance.workingCardId)) {
      throw new PhysicalOrderError("INVALID_PHYSICAL_ORDER", "Physical instance " + instance.id + " references an unknown WorkingCard.");
    }
    counts.set(instance.workingCardId, (counts.get(instance.workingCardId) ?? 0) + 1);
    return { id: instance.id, workingCardId: instance.workingCardId };
  });
  for (const card of byId.values()) {
    if (counts.get(card.id) !== card.quantity) {
      throw new PhysicalOrderError("INVALID_PHYSICAL_ORDER", "Physical instance references do not match quantity for WorkingCard " + card.id + ".");
    }
  }
  if ((source.nextInstanceId as number) <= maxId) {
    throw new PhysicalOrderError("INVALID_PHYSICAL_ORDER", "nextInstanceId must be greater than every allocated physical instance ID.");
  }
  return { nextInstanceId: source.nextInstanceId as number, instances };
}

/** Preserves references and relative order, dropping excess tail copies and inserting new quantity by logical entry. */
export function reconcilePhysicalOrder(cards: readonly OrderedCard[], previous?: PhysicalOrder): PhysicalOrder {
  const byId = cardMap(cards, false);
  if (!previous) return createPhysicalOrder(cards);
  const retained: PhysicalInstanceReference[] = [];
  const counts = new Map<string, number>();
  const ids = new Set<string>();
  let nextInstanceId = Math.max(1, previous.nextInstanceId);
  for (const instance of previous.instances) {
    const numericId = /^instance-([1-9][0-9]{0,15})$/.exec(instance.id)?.[1];
    if (!numericId || !Number.isSafeInteger(Number(numericId))) continue;
    nextInstanceId = Math.max(nextInstanceId, Number(numericId) + 1);
    const card = byId.get(instance.workingCardId);
    const count = counts.get(instance.workingCardId) ?? 0;
    if (!card || count >= card.quantity || ids.has(instance.id)) continue;
    retained.push({ ...instance });
    counts.set(instance.workingCardId, count + 1);
    ids.add(instance.id);
  }
  const refs = [...retained];
  for (const card of ordered(cards)) {
    let missing = card.quantity - (counts.get(card.id) ?? 0);
    while (missing-- > 0) {
      const reference = newReference(nextInstanceId++, card.id);
      const lastIndex = refs.reduce((last, instance, index) => instance.workingCardId === card.id ? index : last, -1);
      const nextLogicalIndex = refs.findIndex((instance) => (byId.get(instance.workingCardId)?.order ?? Number.MAX_SAFE_INTEGER) > card.order);
      const insertionIndex = lastIndex >= 0 ? lastIndex + 1 : nextLogicalIndex < 0 ? refs.length : nextLogicalIndex;
      refs.splice(insertionIndex, 0, reference);
    }
  }
  const total = [...byId.values()].reduce((sum, card) => sum + card.quantity, 0);
  return total > MAX_PHYSICAL_CARDS_PER_EXPORT
    ? { nextInstanceId, instances: refs }
    : validatePhysicalOrder(cards, { nextInstanceId, instances: refs });
}

export function addPhysicalInstance(order: PhysicalOrder, workingCardId: string, afterIndex?: number): { readonly order: PhysicalOrder; readonly instance: PhysicalInstanceReference } {
  if (order.instances.length >= MAX_PHYSICAL_CARDS_PER_EXPORT) {
    throw new PhysicalOrderError("EXPORT_LIMIT_EXCEEDED", "A Project cannot contain more than " + MAX_PHYSICAL_CARDS_PER_EXPORT + " physical cards.");
  }
  const instance = newReference(order.nextInstanceId, workingCardId);
  let index = afterIndex;
  if (index === undefined) {
    index = order.instances.reduce((last, item, itemIndex) => item.workingCardId === workingCardId ? itemIndex : last, -1);
    if (index < 0) index = order.instances.length - 1;
  }
  if (!Number.isSafeInteger(index) || index < -1 || index >= order.instances.length) {
    throw new PhysicalOrderError("INVALID_PHYSICAL_ORDER", "Physical instance insertion position is invalid.");
  }
  const instances = [...order.instances];
  instances.splice(index + 1, 0, instance);
  return { order: { nextInstanceId: order.nextInstanceId + 1, instances }, instance };
}

export function removePhysicalInstance(order: PhysicalOrder, instanceId: string): { readonly order: PhysicalOrder; readonly removed: PhysicalInstanceReference } {
  const index = order.instances.findIndex(({ id }) => id === instanceId);
  if (index < 0) throw new PhysicalOrderError("PHYSICAL_INSTANCE_NOT_FOUND", "Physical instance " + instanceId + " was not found.");
  const instances = [...order.instances];
  const [removed] = instances.splice(index, 1);
  return { order: { ...order, instances }, removed: removed! };
}

export function replacePhysicalInstanceCard(order: PhysicalOrder, instanceId: string, workingCardId: string): PhysicalOrder {
  let found = false;
  const instances = order.instances.map((instance) => {
    if (instance.id !== instanceId) return instance;
    found = true;
    return { ...instance, workingCardId };
  });
  if (!found) throw new PhysicalOrderError("PHYSICAL_INSTANCE_NOT_FOUND", "Physical instance " + instanceId + " was not found.");
  return { ...order, instances };
}

/** Insertion reorder shared by pointer drag and keyboard controls. Null means the final eligible slot. */
export function movePhysicalInstance(order: PhysicalOrder, instanceId: string, targetInstanceId: string | null, placement: "before" | "after" = "after"): PhysicalOrder {
  const from = order.instances.findIndex(({ id }) => id === instanceId);
  if (from < 0) throw new PhysicalOrderError("PHYSICAL_INSTANCE_NOT_FOUND", "Physical instance " + instanceId + " was not found.");
  const remaining = [...order.instances];
  const [moved] = remaining.splice(from, 1);
  if (targetInstanceId === null) return { ...order, instances: [...remaining, moved!] };
  const target = remaining.findIndex(({ id }) => id === targetInstanceId);
  if (target < 0) throw new PhysicalOrderError("PHYSICAL_INSTANCE_NOT_FOUND", "Target physical instance " + targetInstanceId + " was not found.");
  remaining.splice(target + (placement === "after" ? 1 : 0), 0, moved!);
  return { ...order, instances: remaining };
}
