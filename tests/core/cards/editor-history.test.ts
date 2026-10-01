import { describe, expect, it } from "vitest";
import {
  commitEditorHistory,
  createEditorHistoryState,
  editorHistoryShortcut,
  isEditorTextEditingTarget,
  redoEditorHistory,
  resetEditorHistory,
  undoEditorHistory,
  type EditorSnapshot,
} from "../../../core/cards/editor-history";
import type { WorkingCard } from "../../../core/cards/types";

function card(id: string, order: number, quantity = 1): WorkingCard {
  return {
    id,
    order,
    quantity,
    importSource: { sourceId: `source-${id}`, importKind: "text", entryKind: "deck-card" },
    identityHints: { name: id },
    identity: null,
    identityResolution: { status: "unresolved", candidates: [], confirmed: false },
    faces: [{ id: "front", side: "front", name: id }],
    selectedArtworkByFace: { front: { candidateId: `${id}-art`, source: "upload", identityId: null, faceId: "front" } },
    backMode: "project-default",
    backModeSelectionPolicy: "automatic",
    localArtworkIds: [],
    mpcReferences: [],
    faceAssociations: [],
  };
}

function snapshot(cards: readonly WorkingCard[], selectedCardId = cards[0]?.id ?? null): EditorSnapshot {
  return { cards, selectedCardId, face: "front" };
}

describe("editor history", () => {
  it("restores a duplicate with the same WorkingCard ID through undo and redo", () => {
    const before = snapshot([card("a", 0)]);
    const after = snapshot([card("a", 0), card("a-copy", 1)], "a-copy");
    const initial = createEditorHistoryState(before);

    const edited = commitEditorHistory(initial, after);
    const undone = undoEditorHistory(edited);
    const redone = redoEditorHistory(undone);

    expect(edited.past).toHaveLength(1);
    expect(undone.present).toEqual(before);
    expect(undone.present.cards.map(({ id }) => id)).toEqual(["a"]);
    expect(redone.present).toEqual(after);
    expect(redone.present.selectedCardId).toBe("a-copy");
    expect(redone.present.cards[1].id).toBe("a-copy");
  });

  it("keeps redo available when a successful command produces an equivalent snapshot", () => {
    const initial = createEditorHistoryState(snapshot([card("a", 0, 1)]));
    const edited = commitEditorHistory(initial, snapshot([card("a", 0, 2)]));
    const undone = undoEditorHistory(edited);
    const equivalent = snapshot([{ ...undone.present.cards[0] }]);

    const noOp = commitEditorHistory(undone, equivalent);

    expect(noOp).toBe(undone);
    expect(noOp.future).toHaveLength(1);
    expect(redoEditorHistory(noOp).present.cards[0].quantity).toBe(2);
  });

  it("compares snapshots by value rather than requiring shared nested references", () => {
    const sharedMetadata = { imported: true };
    const first = { ...card("a", 0), metadata: sharedMetadata };
    const second = { ...card("b", 1), metadata: sharedMetadata };
    const initial = createEditorHistoryState(snapshot([first, second]));
    const equivalent = snapshot([
      { ...first, metadata: { imported: true } },
      { ...second, metadata: { imported: true } },
    ]);

    expect(commitEditorHistory(initial, equivalent)).toBe(initial);
  });

  it("returns the same state when undo or redo is unavailable", () => {
    const initial = createEditorHistoryState(snapshot([card("a", 0)]));

    expect(undoEditorHistory(initial)).toBe(initial);
    expect(redoEditorHistory(initial)).toBe(initial);
  });

  it("starts a new import context without retaining past or future snapshots", () => {
    const initial = createEditorHistoryState(snapshot([card("old", 0)]));
    const edited = commitEditorHistory(initial, snapshot([card("old", 0, 2)]));
    const undone = undoEditorHistory(edited);

    const loaded = resetEditorHistory(undone, snapshot([card("new", 0)]));

    expect(loaded.present.cards.map(({ id }) => id)).toEqual(["new"]);
    expect(loaded.past).toEqual([]);
    expect(loaded.future).toEqual([]);
    expect(undoEditorHistory(loaded)).toBe(loaded);
    expect(redoEditorHistory(loaded)).toBe(loaded);
  });

  it("does not mutate existing present, past, or future snapshots", () => {
    const before = snapshot([card("a", 0)]);
    const initial = createEditorHistoryState(before);
    const after = snapshot([card("a", 0), card("b", 1)], "b");
    const edited = commitEditorHistory(initial, after);
    const undone = undoEditorHistory(edited);

    expect(initial.present.cards.map(({ id }) => id)).toEqual(["a"]);
    expect(edited.present.cards.map(({ id }) => id)).toEqual(["a", "b"]);
    expect(edited.past[0]).toEqual(before);
    expect(undone.present).toEqual(before);
    expect(undone.future[0]).toEqual(after);
  });

  it.each([
    [{ key: "z", ctrlKey: true }, false, "undo"],
    [{ key: "Z", metaKey: true }, false, "undo"],
    [{ key: "y", ctrlKey: true }, false, "redo"],
    [{ key: "y", metaKey: true }, false, "redo"],
    [{ key: "z", ctrlKey: true, shiftKey: true }, false, "redo"],
    [{ key: "Z", metaKey: true, shiftKey: true }, false, "redo"],
    [{ key: "z", ctrlKey: true }, true, null],
    [{ key: "z", metaKey: true, altKey: true }, false, null],
    [{ key: "z", ctrlKey: true, isComposing: true }, false, null],
    [{ key: "z" }, false, null],
  ])("maps editor shortcuts without stealing native text editing: %j", (input, textEditingFocused, expected) => {
    expect(editorHistoryShortcut(input, textEditingFocused)).toBe(expected);
  });

  it.each([
    [{ tagName: "INPUT" }, true],
    [{ tagName: "TEXTAREA" }, true],
    [{ tagName: "SELECT" }, true],
    [{ tagName: "DIV", isContentEditable: true }, true],
    [{ tagName: "DIV", isContentEditable: false }, false],
    [null, false],
  ])("identifies text-editing targets %j", (target, expected) => {
    expect(isEditorTextEditingTarget(target)).toBe(expected);
  });
});
