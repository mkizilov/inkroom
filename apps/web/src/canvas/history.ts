import {
  applyOperations,
  diffDocuments,
  type CanvasObject,
  type CanvasOperation,
} from '@inkroom/shared';

// Each undoable step stores the operations both ways. Undo applies the inverse, and redo applies
// the forward operations again. Steps are the same operations a collaborative session would send.
export interface HistoryEntry {
  forward: CanvasOperation[];
  inverse: CanvasOperation[];
}

export interface History {
  past: HistoryEntry[];
  future: HistoryEntry[];
}

export const EMPTY_HISTORY: History = { past: [], future: [] };
export const MAX_HISTORY = 200;

// Records the change from `before` to `after` as one step. Does nothing when nothing changed.
// A new change discards the redo stack.
export function recordChange(
  history: History,
  before: readonly CanvasObject[],
  after: readonly CanvasObject[],
): History {
  const forward = diffDocuments(before, after);
  if (forward.length === 0) {
    return history;
  }
  const inverse = diffDocuments(after, before);
  return {
    past: [...history.past, { forward, inverse }].slice(-MAX_HISTORY),
    future: [],
  };
}

export function undoChange(
  objects: readonly CanvasObject[],
  history: History,
): { objects: CanvasObject[]; history: History } | null {
  const entry = history.past.at(-1);
  if (!entry) {
    return null;
  }
  return {
    objects: applyOperations(objects, entry.inverse),
    history: {
      past: history.past.slice(0, -1),
      future: [entry, ...history.future],
    },
  };
}

export function redoChange(
  objects: readonly CanvasObject[],
  history: History,
): { objects: CanvasObject[]; history: History } | null {
  const entry = history.future[0];
  if (!entry) {
    return null;
  }
  return {
    objects: applyOperations(objects, entry.forward),
    history: {
      past: [...history.past, entry],
      future: history.future.slice(1),
    },
  };
}
