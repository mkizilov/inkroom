import type { Board } from '@inkroom/shared';
import { boardKey, type LocalStore, type StoredBoard } from './local-store';

// IndexedDB storage for the copies of boards on this device: one row per saved Yjs update, and one
// row per board with its cached details. Removing a user matches keys by their "<userId>/" prefix.

const DB_NAME = 'inkroom-offline';
const DB_VERSION = 1;
const UPDATES = 'updates';
const BOARDS = 'boards';

interface UpdateRow {
  key: string;
  update: Uint8Array;
}

interface BoardRow {
  key: string;
  board: Board;
  savedAt: string;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('The local copy could not be written.'));
  });
}

// Deletes the update rows whose key matches. Runs inside the transaction that owns the store.
function deleteUpdates(updates: IDBObjectStore, query: string | IDBKeyRange): void {
  const keys = updates.index('key').getAllKeys(query);
  keys.onsuccess = () => {
    for (const primaryKey of keys.result) {
      updates.delete(primaryKey);
    }
  };
}

function userRange(userId: string): IDBKeyRange {
  return IDBKeyRange.bound(`${userId}/`, `${userId}/\uffff`);
}

export class IndexedDbLocalStore implements LocalStore {
  private database: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    if (!this.database) {
      this.database = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const database = request.result;
          database.createObjectStore(UPDATES, { autoIncrement: true }).createIndex('key', 'key');
          database.createObjectStore(BOARDS, { keyPath: 'key' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    return this.database;
  }

  private async write(
    stores: string[],
    work: (transaction: IDBTransaction) => void,
  ): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction(stores, 'readwrite');
    work(transaction);
    await transactionDone(transaction);
  }

  private async read<T>(
    store: string,
    query: (objects: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const database = await this.open();
    return requestResult(query(database.transaction(store, 'readonly').objectStore(store)));
  }

  async loadUpdates(userId: string, boardId: string): Promise<Uint8Array[]> {
    const rows = await this.read<UpdateRow[]>(UPDATES, (objects) =>
      objects.index('key').getAll(boardKey(userId, boardId)),
    );
    return rows.map((row) => row.update);
  }

  appendUpdate(userId: string, boardId: string, update: Uint8Array): Promise<void> {
    const row: UpdateRow = { key: boardKey(userId, boardId), update };
    return this.write([UPDATES], (transaction) => {
      transaction.objectStore(UPDATES).add(row);
    });
  }

  replaceUpdates(userId: string, boardId: string, update: Uint8Array): Promise<void> {
    const key = boardKey(userId, boardId);
    return this.write([UPDATES], (transaction) => {
      const updates = transaction.objectStore(UPDATES);
      const keys = updates.index('key').getAllKeys(key);
      keys.onsuccess = () => {
        for (const primaryKey of keys.result) {
          updates.delete(primaryKey);
        }
        const row: UpdateRow = { key, update };
        updates.add(row);
      };
    });
  }

  saveBoard(userId: string, board: Board): Promise<void> {
    const row: BoardRow = {
      key: boardKey(userId, board.id),
      board,
      savedAt: new Date().toISOString(),
    };
    return this.write([BOARDS], (transaction) => {
      transaction.objectStore(BOARDS).put(row);
    });
  }

  async loadBoard(userId: string, boardId: string): Promise<StoredBoard | null> {
    const row = await this.read<BoardRow | undefined>(BOARDS, (objects) =>
      objects.get(boardKey(userId, boardId)),
    );
    return row ? { board: row.board, savedAt: row.savedAt } : null;
  }

  removeBoard(userId: string, boardId: string): Promise<void> {
    const key = boardKey(userId, boardId);
    return this.write([UPDATES, BOARDS], (transaction) => {
      deleteUpdates(transaction.objectStore(UPDATES), key);
      transaction.objectStore(BOARDS).delete(key);
    });
  }

  removeUser(userId: string): Promise<void> {
    const range = userRange(userId);
    return this.write([UPDATES, BOARDS], (transaction) => {
      deleteUpdates(transaction.objectStore(UPDATES), range);
      transaction.objectStore(BOARDS).delete(range);
    });
  }
}

let shared: LocalStore | null | undefined;

// The store for this browser, or null where IndexedDB is missing. Without it, boards work online
// only, as they did before offline support.
export function browserLocalStore(): LocalStore | null {
  if (shared === undefined) {
    shared = typeof indexedDB === 'undefined' ? null : new IndexedDbLocalStore();
  }
  return shared;
}
