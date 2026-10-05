import { describe, expect, it } from "vitest";
import type { WorkingCard } from "../../../core/cards/types";
import { createWorkingCardEditorState, deleteWorkingCard, duplicatePhysicalInstanceAsEntry, removeWorkingCardPhysicalInstance, reorderWorkingCardPhysicalInstance, setWorkingCardQuantity } from "../../../core/cards/working-card-editor";
import { commitEditorHistory, createEditorHistoryState, redoEditorHistory, undoEditorHistory } from "../../../core/cards/editor-history";
import {
  addPhysicalInstance,
  createPhysicalOrder,
  movePhysicalInstance,
  reconcilePhysicalOrder,
  removePhysicalInstance,
  replacePhysicalInstanceCard,
  validatePhysicalOrder,
} from "../../../core/cards/physical-instance-order";

function card(id: string, order: number, quantity = 1): WorkingCard {
  return {
    id, order, quantity,
    importSource: { sourceId: `source-${id}`, importKind: "text", entryKind: "card" },
    identityHints: { name: id }, identity: null,
    identityResolution: { status: "unresolved", candidates: [], confirmed: false },
    faces: [{ id: "front", side: "front", name: id }], selectedArtworkByFace: {},
    backMode: "project-default", backModeSelectionPolicy: "automatic", localArtworkIds: [], mpcReferences: [], faceAssociations: [],
  };
}

describe("durable physical instance order", () => {
  it("derives legacy order deterministically and gives every copy a stable unique ID", () => {
    const cards = [card("bolt", 1), card("island", 0, 3)];
    const first = createPhysicalOrder(cards);
    const reopened = createPhysicalOrder(cards);

    expect(first).toEqual(reopened);
    expect(first.instances.map(({ workingCardId }) => workingCardId)).toEqual(["island", "island", "island", "bolt"]);
    expect(new Set(first.instances.map(({ id }) => id)).size).toBe(4);
  });

  it("inserts a dragged physical copy after the target without splitting or changing quantities", () => {
    const cards = [card("island", 0, 4), card("bolt", 1)];
    const order = createPhysicalOrder(cards);
    const [a, b, c, d, e] = order.instances;
    const custom = { ...order, instances: [a!, b!, e!, c!, d!] };
    const moved = movePhysicalInstance(custom, b!.id, e!.id, "after");

    expect(moved.instances.map(({ id }) => id)).toEqual([a!.id, e!.id, b!.id, c!.id, d!.id]);
    expect(cards.map(({ id, quantity }) => [id, quantity])).toEqual([["island", 4], ["bolt", 1]]);
  });

  it("supports insertion before and moving to the final eligible slot", () => {
    const order = createPhysicalOrder([card("a", 0), card("b", 1), card("c", 2)]);
    const [a, b, c] = order.instances;
    expect(movePhysicalInstance(order, a!.id, c!.id, "before").instances.map(({ workingCardId }) => workingCardId)).toEqual(["b", "a", "c"]);
    expect(movePhysicalInstance(order, b!.id, null, "after").instances.map(({ workingCardId }) => workingCardId)).toEqual(["a", "c", "b"]);
  });

  it("retains existing references and adds quantity beside its logical entry", () => {
    const cards = [card("a", 0, 2), card("b", 1)];
    const order = createPhysicalOrder(cards);
    const [a1, a2, b] = order.instances;
    const added = addPhysicalInstance(order, "a");

    expect(added.instance.id).not.toBe(a1!.id);
    expect(added.instance.id).not.toBe(a2!.id);
    expect(added.order.instances.map(({ workingCardId }) => workingCardId)).toEqual(["a", "a", "a", "b"]);
    expect(added.order.instances[0]).toBe(a1);
    expect(added.order.instances[1]).toBe(a2);
    expect(added.order.instances[3]).toBe(b);
  });

  it("removes exactly the requested physical instance and keeps the rest ordered", () => {
    const order = createPhysicalOrder([card("a", 0, 3), card("b", 1)]);
    const [a1, a2, a3, b] = order.instances;
    const removed = removePhysicalInstance(order, a2!.id);
    expect(removed.removed).toEqual(a2);
    expect(removed.order.instances).toEqual([a1, a3, b]);
  });

  it("reconciles delete, quantity decreases and M6 split without moving the split instance", () => {
    const cards = [card("island", 0, 4), card("bolt", 1)];
    const order = createPhysicalOrder(cards);
    const [one, two, three, four, bolt] = order.instances;
    const physical = { ...order, instances: [one!, bolt!, two!, three!, four!] };
    const splitCards = [card("island", 0, 3), card("island-alt", 1), card("bolt", 2)];
    const splitOrder = replacePhysicalInstanceCard(physical, three!.id, "island-alt");
    const reconciled = reconcilePhysicalOrder(splitCards, splitOrder);

    expect(reconciled.instances.map(({ workingCardId }) => workingCardId)).toEqual(["island", "bolt", "island", "island-alt", "island"]);
    expect(reconciled.instances[3]?.id).toBe(three!.id);
    expect(reconciled.instances[1]?.id).toBe(bolt!.id);
  });

  it("rejects malformed IDs, duplicated IDs, missing or extra quantity refs and dangling cards", () => {
    const cards = [card("a", 0, 2)];
    const order = createPhysicalOrder(cards);
    expect(() => validatePhysicalOrder(cards, { ...order, instances: [order.instances[0]!] })).toThrow(/quantit|references must match/i);
    expect(() => validatePhysicalOrder(cards, { ...order, instances: [order.instances[0]!, { ...order.instances[0]! }] })).toThrow(/duplicate/i);
    expect(() => validatePhysicalOrder(cards, { ...order, instances: [{ id: "bad id", workingCardId: "a" }, order.instances[1]!] })).toThrow(/instance ID/i);
    expect(() => validatePhysicalOrder(cards, { ...order, instances: [order.instances[0]!, { ...order.instances[1]!, workingCardId: "gone" }] })).toThrow(/WorkingCard/i);
  });

  it("keeps quantity compact for one-copy reorder and reconciles quantity changes without recreating stable IDs", () => {
    const cards = [card("island", 0, 4), card("bolt", 1)];
    const initial = createWorkingCardEditorState(cards);
    const [first, second, third, fourth, bolt] = initial.physicalOrder.instances;
    const custom = { ...initial, physicalOrder: { ...initial.physicalOrder, instances: [first!, second!, bolt!, third!, fourth!] } };
    const reordered = reorderWorkingCardPhysicalInstance(custom, third!.id, fourth!.id, "after");

    expect(reordered.cards.map(({ id, quantity }) => [id, quantity])).toEqual([["island", 4], ["bolt", 1]]);
    expect(reordered.physicalOrder.instances.map(({ id }) => id)).toEqual([first!.id, second!.id, bolt!.id, fourth!.id, third!.id]);

    const increased = setWorkingCardQuantity(reordered, "island", 5);
    expect(increased.physicalOrder.instances.filter(({ workingCardId }) => workingCardId === "island").map(({ id }) => id).slice(0, 4))
      .toEqual([first!.id, second!.id, fourth!.id, third!.id]);
    expect(increased.physicalOrder.instances.at(-1)?.workingCardId).toBe("island");
    const decreased = setWorkingCardQuantity(increased, "island", 4);
    expect(decreased.physicalOrder.instances.filter(({ workingCardId }) => workingCardId === "island")).toHaveLength(4);
    expect(decreased.physicalOrder.instances.filter(({ workingCardId }) => workingCardId === "island").map(({ id }) => id).slice(0, 4))
      .toEqual([first!.id, second!.id, fourth!.id, third!.id]);
  });

  it("removes the selected copy, duplicates only it as an independent entry, and deletes every entry reference", () => {
    const initial = createWorkingCardEditorState([card("island", 0, 3), card("bolt", 1)]);
    const selected = initial.physicalOrder.instances[1]!;
    const removed = removeWorkingCardPhysicalInstance(initial, selected.id);
    expect(removed.cards.find(({ id }) => id === "island")?.quantity).toBe(2);
    expect(removed.physicalOrder.instances.map(({ id }) => id)).toEqual(["instance-1", "instance-3", "instance-4"]);

    const duplicated = duplicatePhysicalInstanceAsEntry(removed, "instance-3", "island-independent");
    expect(duplicated.cards.map(({ id, quantity }) => [id, quantity])).toEqual([["island", 2], ["island-independent", 1], ["bolt", 1]]);
    expect(duplicated.physicalOrder.instances.map(({ workingCardId }) => workingCardId)).toEqual(["island", "island", "island-independent", "bolt"]);
    const deleted = deleteWorkingCard(duplicated, "island");
    expect(deleted.physicalOrder.instances.map(({ workingCardId }) => workingCardId)).toEqual(["island-independent", "bolt"]);
  });

  it("records reorder as one undo and redo step", () => {
    const initial = createWorkingCardEditorState([card("a", 0), card("b", 1), card("c", 2)]);
    const reordered = reorderWorkingCardPhysicalInstance(initial, "instance-2", "instance-3", "after");
    const snapshot = (state: typeof initial) => ({ ...state, face: "front" as const });
    const committed = commitEditorHistory(createEditorHistoryState(snapshot(initial)), snapshot(reordered));

    expect(undoEditorHistory(committed).present.physicalOrder.instances.map(({ id }) => id)).toEqual(["instance-1", "instance-2", "instance-3"]);
    expect(redoEditorHistory(undoEditorHistory(committed)).present.physicalOrder.instances.map(({ id }) => id)).toEqual(["instance-1", "instance-3", "instance-2"]);
  });
});
