import * as Y from 'yjs';
import { REMOTE_ORIGIN, type CanvasDocument } from '../canvas/doc/canvas-document';
import type { LocalStore } from './local-store';

// Keeps a board's changes on this device, so the board opens and can be edited without a connection,
// and its changes survive a reload. Every update the document applies is saved, whether the editor
// made it or the server sent it. The saved log is therefore the whole document, and loading it gives
// the board as it was. The reconnect handshake then sends whatever the server lacks.

// Once this many updates have been saved since the last compaction, the log is replaced by the
// document's current state, which holds the same changes in one row.
const DEFAULT_COMPACT_AFTER = 200;

export interface LocalBoardOptions {
  store: LocalStore;
  userId: string;
  boardId: string;
  document: CanvasDocument;
  // Told when a save fails. The document keeps the change in memory, but it is not on the device.
  onSaveError: (error: unknown) => void;
  compactAfter?: number;
}

export class LocalBoard {
  private readonly options: LocalBoardOptions;
  private readonly compactAfter: number;
  private queue: Promise<void> = Promise.resolve();
  private loading = false;
  private stopped = false;
  private savedSinceCompaction = 0;

  constructor(options: LocalBoardOptions) {
    this.options = options;
    this.compactAfter = options.compactAfter ?? DEFAULT_COMPACT_AFTER;
    options.document.doc.on('update', this.onUpdate);
  }

  // Loads the saved updates into the document. They are applied as remote changes, so they are not
  // sent to the server again and local undo does not track them. Compacts the log if it has grown.
  async open(): Promise<void> {
    const { store, userId, boardId, document } = this.options;
    const updates = await store.loadUpdates(userId, boardId);
    this.loading = true;
    try {
      for (const update of updates) {
        Y.applyUpdate(document.doc, update, REMOTE_ORIGIN);
      }
    } finally {
      this.loading = false;
    }
    if (updates.length > this.compactAfter) {
      this.enqueue(() =>
        store.replaceUpdates(userId, boardId, Y.encodeStateAsUpdate(document.doc)),
      );
    }
  }

  // Stops listening, and waits for the saves already queued. A later session then reads all of them.
  async close(): Promise<void> {
    this.options.document.doc.off('update', this.onUpdate);
    await this.queue;
  }

  // Stops saving and deletes this board's copy. Used when the user's access to the board has ended.
  async discard(): Promise<void> {
    this.stopped = true;
    this.options.document.doc.off('update', this.onUpdate);
    await this.queue;
    await this.options.store.removeBoard(this.options.userId, this.options.boardId);
  }

  private readonly onUpdate = (update: Uint8Array): void => {
    if (!this.loading && !this.stopped) {
      this.save(update);
    }
  };

  private save(update: Uint8Array): void {
    const { store, userId, boardId, document } = this.options;
    this.enqueue(() => store.appendUpdate(userId, boardId, update));
    this.savedSinceCompaction += 1;
    if (this.savedSinceCompaction >= this.compactAfter) {
      this.savedSinceCompaction = 0;
      // The state is read when this task runs, so it includes every update queued before it.
      this.enqueue(() =>
        store.replaceUpdates(userId, boardId, Y.encodeStateAsUpdate(document.doc)),
      );
    }
  }

  // Runs saves one after another, in the order the changes were made. A failed save is reported
  // and the queue carries on, so one failure does not hold up the saves after it.
  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue
      .then(() => (this.stopped ? undefined : task()))
      .catch((error: unknown) => this.options.onSaveError(error));
  }
}
