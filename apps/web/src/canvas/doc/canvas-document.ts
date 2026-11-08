import * as Y from 'yjs';
import {
  applyOperations,
  OperationError,
  type CanvasObject,
  type CanvasOperation,
} from '@inkroom/shared';
import {
  Awareness,
  objectsMapOf,
  readOrderedObjects,
  writeOperations,
  type ObjectsMap,
} from '@inkroom/shared';

// Origins decide what local undo can see. Local edits are tracked; remote updates are applied with
// REMOTE_ORIGIN and are not tracked, so undo never reverts another person's change.
export const LOCAL_ORIGIN = { source: 'local' } as const;
export const REMOTE_ORIGIN = { source: 'remote' } as const;

// Writes within this many milliseconds of each other can share one undo step, unless a write is
// marked as a boundary. Discrete actions always start a new step, so this only groups the
// continuous parts of one action, such as the moves of a drag or keystrokes in a text edit.
export const CAPTURE_TIMEOUT_MS = 60_000;

export interface DocumentChange {
  origin: unknown;
}

export interface WriteOptions {
  // True starts a new undo step. False joins the step that is open.
  boundary: boolean;
}

// The collaborative document for one board's canvas. It owns the Yjs document and its undo
// manager, and it notifies listeners of every change, whatever its origin.
export class CanvasDocument {
  readonly doc: Y.Doc;
  readonly objects: ObjectsMap;
  // Live presence for this board. It is ephemeral: it travels over the sync socket and is not part
  // of the document, so it is never stored or undone.
  readonly awareness = new Awareness();
  private readonly undoManager: Y.UndoManager;
  private readonly listeners = new Set<(change: DocumentChange) => void>();

  constructor(doc: Y.Doc = new Y.Doc()) {
    this.doc = doc;
    this.objects = objectsMapOf(doc);
    this.undoManager = new Y.UndoManager(this.objects, {
      trackedOrigins: new Set<unknown>([LOCAL_ORIGIN]),
      captureTimeout: CAPTURE_TIMEOUT_MS,
    });
    this.objects.observeDeep((_events, transaction) => {
      const change: DocumentChange = { origin: transaction.origin };
      for (const listener of this.listeners) {
        listener(change);
      }
    });
  }

  // The current objects in z-order. Entries that are not valid canvas objects are left out, and
  // invalidIds() reports them.
  snapshot(): CanvasObject[] {
    return readOrderedObjects(this.objects).objects;
  }

  invalidIds(): string[] {
    return readOrderedObjects(this.objects).invalidIds;
  }

  subscribe(listener: (change: DocumentChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // Emits the updates produced by local writes and by undo and redo, which a network layer would
  // send to other replicas. Remote updates are not re-emitted.
  onLocalUpdate(listener: (update: Uint8Array) => void): () => void {
    const handler = (update: Uint8Array, origin: unknown) => {
      if (origin !== REMOTE_ORIGIN) {
        listener(update);
      }
    };
    this.doc.on('update', handler);
    return () => {
      this.doc.off('update', handler);
    };
  }

  // Applies a local change as one Yjs transaction. The whole batch is checked against the current
  // document first, so an invalid batch writes nothing.
  apply(operations: readonly CanvasOperation[], options: WriteOptions): void {
    if (operations.length === 0) {
      return;
    }
    const current = readOrderedObjects(this.objects);
    if (current.invalidIds.length > 0) {
      const ids = current.invalidIds.join(', ');
      throw new OperationError(`The document has invalid objects, so it cannot change: ${ids}.`);
    }
    applyOperations(current.objects, operations);

    if (options.boundary) {
      this.undoManager.stopCapturing();
    }
    this.doc.transact(() => writeOperations(this.objects, operations), LOCAL_ORIGIN);
  }

  // Applies an update received from another replica.
  applyRemote(update: Uint8Array): void {
    Y.applyUpdate(this.doc, update, REMOTE_ORIGIN);
  }

  encodeState(): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc);
  }

  canUndo(): boolean {
    return this.undoManager.canUndo();
  }

  canRedo(): boolean {
    return this.undoManager.canRedo();
  }

  // Undo and redo start new steps on either side of themselves, so later edits are not merged
  // into the step that was just reverted.
  undo(): boolean {
    this.undoManager.stopCapturing();
    const undone = this.undoManager.undo() !== null;
    this.undoManager.stopCapturing();
    return undone;
  }

  redo(): boolean {
    this.undoManager.stopCapturing();
    const redone = this.undoManager.redo() !== null;
    this.undoManager.stopCapturing();
    return redone;
  }

  destroy(): void {
    this.awareness.destroy();
    this.undoManager.destroy();
    this.doc.destroy();
  }
}
