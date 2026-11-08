import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import type { CanvasObject } from '@inkroom/shared';
import { CanvasDocument } from '../canvas/doc/canvas-document';
import { LocalBoard } from './local-board';
import { MemoryLocalStore, type LocalStore } from './local-store';

const USER = '00000000-0000-4000-8000-0000000000aa';
const BOARD = '00000000-0000-4000-8000-0000000000bb';

function rectangle(n: number): CanvasObject {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    type: 'rectangle',
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    stroke: '#000000',
    strokeWidth: 2,
  };
}

function insertRectangle(document: CanvasDocument, n: number): void {
  document.apply([{ type: 'insert', index: document.snapshot().length, objects: [rectangle(n)] }], {
    boundary: true,
  });
}

function localBoard(
  store: LocalStore,
  document: CanvasDocument,
  options: { onSaveError?: (error: unknown) => void; compactAfter?: number } = {},
): LocalBoard {
  return new LocalBoard({
    store,
    userId: USER,
    boardId: BOARD,
    document,
    onSaveError: options.onSaveError ?? (() => undefined),
    compactAfter: options.compactAfter,
  });
}

function idsOf(document: CanvasDocument): string[] {
  return document
    .snapshot()
    .map((object) => object.id)
    .sort();
}

class FailingStore extends MemoryLocalStore {
  override async appendUpdate(): Promise<void> {
    throw new Error('quota exceeded');
  }
}

describe('local copy of a board', () => {
  it('keeps what was drawn, and a new session loads it', async () => {
    const store = new MemoryLocalStore();
    const first = new CanvasDocument();
    const writer = localBoard(store, first);
    await writer.open();
    insertRectangle(first, 1);
    await writer.close();

    const second = new CanvasDocument();
    const reader = localBoard(store, second);
    await reader.open();
    await reader.close();

    expect(idsOf(second)).toEqual([rectangle(1).id]);
  });

  it('does not save again what it loads', async () => {
    const store = new MemoryLocalStore();
    const first = new CanvasDocument();
    const writer = localBoard(store, first);
    await writer.open();
    insertRectangle(first, 1);
    await writer.close();
    const savedBefore = (await store.loadUpdates(USER, BOARD)).length;

    const reader = localBoard(store, new CanvasDocument());
    await reader.open();
    await reader.close();

    expect((await store.loadUpdates(USER, BOARD)).length).toBe(savedBefore);
  });

  it('merges concurrent offline edits from two devices without duplicates', async () => {
    const phoneStore = new MemoryLocalStore();
    const laptopStore = new MemoryLocalStore();
    const phone = new CanvasDocument();
    const laptop = new CanvasDocument();
    const phoneBoard = localBoard(phoneStore, phone);
    const laptopBoard = localBoard(laptopStore, laptop);
    await phoneBoard.open();
    await laptopBoard.open();

    // Both devices edit while offline.
    insertRectangle(phone, 1);
    insertRectangle(laptop, 2);

    // They reconnect and exchange what each lacks.
    laptop.applyRemote(Y.encodeStateAsUpdate(phone.doc));
    phone.applyRemote(Y.encodeStateAsUpdate(laptop.doc));
    await phoneBoard.close();
    await laptopBoard.close();

    const reloaded = new CanvasDocument();
    const reload = localBoard(laptopStore, reloaded);
    await reload.open();
    await reload.close();

    expect(idsOf(phone)).toEqual([rectangle(1).id, rectangle(2).id].sort());
    expect(idsOf(laptop)).toEqual(idsOf(phone));
    expect(idsOf(reloaded)).toEqual(idsOf(phone));
  });

  it('stops saving and deletes the copy when discarded', async () => {
    const store = new MemoryLocalStore();
    const document = new CanvasDocument();
    const board = localBoard(store, document);
    await board.open();
    insertRectangle(document, 1);

    await board.discard();
    insertRectangle(document, 2);

    expect(await store.loadUpdates(USER, BOARD)).toEqual([]);
    expect(idsOf(document)).toHaveLength(2);
  });

  it('reports a failed save and keeps the change in the document', async () => {
    const errors: unknown[] = [];
    const document = new CanvasDocument();
    const board = localBoard(new FailingStore(), document, {
      onSaveError: (error) => errors.push(error),
    });
    await board.open();
    insertRectangle(document, 1);
    await board.close();

    expect(errors).toHaveLength(1);
    expect(idsOf(document)).toHaveLength(1);
  });

  it('replaces the log with one update once it has grown', async () => {
    const store = new MemoryLocalStore();
    const document = new CanvasDocument();
    const board = localBoard(store, document, { compactAfter: 3 });
    await board.open();
    insertRectangle(document, 1);
    insertRectangle(document, 2);
    insertRectangle(document, 3);
    await board.close();

    expect(await store.loadUpdates(USER, BOARD)).toHaveLength(1);
    const reloaded = new CanvasDocument();
    const reload = localBoard(store, reloaded);
    await reload.open();
    await reload.close();
    expect(idsOf(reloaded)).toEqual([1, 2, 3].map((n) => rectangle(n).id).sort());
  });
});
