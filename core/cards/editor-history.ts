import type { CardFaceSide, WorkingCard } from "./types";

export interface EditorSnapshot {
  readonly cards: readonly WorkingCard[];
  readonly selectedCardId: string | null;
  readonly face: CardFaceSide;
}

export interface EditorHistoryState {
  readonly present: EditorSnapshot;
  readonly past: readonly EditorSnapshot[];
  readonly future: readonly EditorSnapshot[];
}

export interface EditorHistoryShortcutInput {
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
  readonly altKey?: boolean;
  readonly isComposing?: boolean;
}

export interface EditorHistoryShortcutTarget {
  readonly tagName?: string;
  readonly isContentEditable?: boolean;
}

function copySnapshot(snapshot: EditorSnapshot): EditorSnapshot {
  return {
    cards: [...snapshot.cards],
    selectedCardId: snapshot.selectedCardId,
    face: snapshot.face,
  };
}

function valuesEqual(left: unknown, right: unknown, seen = new WeakMap<object, WeakSet<object>>()): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;

  let paired = seen.get(left);
  if (paired?.has(right)) return true;
  if (!paired) {
    paired = new WeakSet<object>();
    seen.set(left, paired);
  }
  paired.add(right);

  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => valuesEqual(value, right[index], seen));
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.hasOwn(rightRecord, key) && valuesEqual(leftRecord[key], rightRecord[key], seen));
}

export function editorSnapshotsEqual(left: EditorSnapshot, right: EditorSnapshot): boolean {
  return left.selectedCardId === right.selectedCardId
    && left.face === right.face
    && valuesEqual(left.cards, right.cards);
}

export function createEditorHistoryState(present: EditorSnapshot): EditorHistoryState {
  return { present: copySnapshot(present), past: [], future: [] };
}

/** Update navigation-only state without making it undoable or discarding Redo. */
export function updateEditorHistoryPresent(state: EditorHistoryState, present: EditorSnapshot): EditorHistoryState {
  if (editorSnapshotsEqual(state.present, present)) return state;
  return { ...state, present: copySnapshot(present) };
}

/** Record one successful editorial operation; equivalent results are not history steps. */
export function commitEditorHistory(state: EditorHistoryState, present: EditorSnapshot): EditorHistoryState {
  if (editorSnapshotsEqual(state.present, present)) return state;
  return {
    present: copySnapshot(present),
    past: [...state.past, copySnapshot(state.present)],
    future: [],
  };
}

export function undoEditorHistory(state: EditorHistoryState): EditorHistoryState {
  if (state.past.length === 0) return state;
  const previous = state.past[state.past.length - 1];
  return {
    present: copySnapshot(previous),
    past: state.past.slice(0, -1),
    future: [...state.future, copySnapshot(state.present)],
  };
}

export function redoEditorHistory(state: EditorHistoryState): EditorHistoryState {
  if (state.future.length === 0) return state;
  const next = state.future[state.future.length - 1];
  return {
    present: copySnapshot(next),
    past: [...state.past, copySnapshot(state.present)],
    future: state.future.slice(0, -1),
  };
}

/** A successful import starts a new history context rather than becoming an undoable edit. */
export function resetEditorHistory(state: EditorHistoryState, present: EditorSnapshot): EditorHistoryState {
  return { present: copySnapshot(present), past: [], future: [] };
}

export function editorHistoryShortcut(input: EditorHistoryShortcutInput, textEditingFocused: boolean): "undo" | "redo" | null {
  if (textEditingFocused || input.altKey || input.isComposing || (!input.ctrlKey && !input.metaKey)) return null;
  const key = input.key.toLowerCase();
  if (key === "z") return input.shiftKey ? "redo" : "undo";
  if (key === "y" && !input.shiftKey) return "redo";
  return null;
}

export function isEditorTextEditingTarget(target: EditorHistoryShortcutTarget | null): boolean {
  const tagName = target?.tagName?.toLowerCase();
  return tagName === "input"
    || tagName === "textarea"
    || tagName === "select"
    || target?.isContentEditable === true;
}
