import type { Board } from '@inkroom/shared';

// The copies of boards kept on this device. Everything is keyed by the signed-in user as well as the
// board, so two people who use the same browser never see each other's copies.
export interface StoredBoard {
  board: Board;
  savedAt: string;
}

export interface LocalStore {
  // The Yjs updates kept for one board, in the order they were saved.
  loadUpdates(userId: string, boardId: string): Promise<Uint8Array[]>;
  appendUpdate(userId: string, boardId: string, update: Uint8Array): Promise<void>;
  // Replaces every saved update for the board with one update that holds all of them.
  replaceUpdates(userId: string, boardId: string, update: Uint8Array): Promise<void>;
  saveBoard(userId: string, board: Board): Promise<void>;
  loadBoard(userId: string, boardId: string): Promise<StoredBoard | null>;
  // Deletes a board's updates and its cached details.
  removeBoard(userId: string, boardId: string): Promise<void>;
  // Deletes everything kept for a user.
  removeUser(userId: string): Promise<void>;
}

export function boardKey(userId: string, boardId: string): string {
  return `${userId}/${boardId}`;
}

// Keeps everything in memory. Used by tests; the browser uses IndexedDB (indexeddb-store.ts).
export class MemoryLocalStore implements LocalStore {
  private readonly updates = new Map<string, Uint8Array[]>();
  private readonly boards = new Map<string, StoredBoard>();

  async loadUpdates(userId: string, boardId: string): Promise<Uint8Array[]> {
    return [...(this.updates.get(boardKey(userId, boardId)) ?? [])];
  }

  async appendUpdate(userId: string, boardId: string, update: Uint8Array): Promise<void> {
    const key = boardKey(userId, boardId);
    this.updates.set(key, [...(this.updates.get(key) ?? []), update]);
  }

  async replaceUpdates(userId: string, boardId: string, update: Uint8Array): Promise<void> {
    this.updates.set(boardKey(userId, boardId), [update]);
  }

  async saveBoard(userId: string, board: Board): Promise<void> {
    this.boards.set(boardKey(userId, board.id), {
      board,
      savedAt: new Date().toISOString(),
    });
  }

  async loadBoard(userId: string, boardId: string): Promise<StoredBoard | null> {
    return this.boards.get(boardKey(userId, boardId)) ?? null;
  }

  async removeBoard(userId: string, boardId: string): Promise<void> {
    const key = boardKey(userId, boardId);
    this.updates.delete(key);
    this.boards.delete(key);
  }

  async removeUser(userId: string): Promise<void> {
    const prefix = `${userId}/`;
    for (const key of [...this.updates.keys(), ...this.boards.keys()]) {
      if (key.startsWith(prefix)) {
        this.updates.delete(key);
        this.boards.delete(key);
      }
    }
  }
}
