import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createBoard } from '../db/repositories/boards';
import { createUser } from '../db/repositories/users';
import {
  createTestDatabase,
  describeWithDatabase,
  testDatabaseUrl,
  type TestDatabase,
} from '../db/test-database';
import {
  BoardNotFoundError,
  PostgresBoardStore,
  RevisionNotFoundError,
  type BoardStore,
} from './store';

// These tests run against PostgreSQL. Each file migrates into its own schema (see test-database).

const skipped: Array<{ boardId: string; seq: number }> = [];
const onSkipped = (boardId: string, seq: number) => {
  skipped.push({ boardId, seq });
};

// A readable label maps to a fixed UUID, so tests can name objects and still use valid ids.
const uid = (label: string) =>
  `00000000-0000-4000-8000-${Buffer.from(label).toString('hex').padStart(12, '0')}`;
const idsOf = (...labels: string[]) => labels.map(uid).sort();

// Produces the Yjs update for one change to a client document. Successive calls build on the same
// client state, so the updates must be stored in the order they were produced.
function changeFor(client: Y.Doc, change: (doc: Y.Doc) => void): Uint8Array {
  const updates: Uint8Array[] = [];
  const record = (update: Uint8Array) => updates.push(update);
  client.on('update', record);
  client.transact(() => change(client));
  client.off('update', record);
  return Y.mergeUpdates(updates);
}

// A typed text object, in the shape the canvas model reads.
function putObject(client: Y.Doc, label: string): Uint8Array {
  return changeFor(client, (doc) => {
    const objects = doc.getMap<Y.Map<unknown>>('objects');
    const map = new Y.Map<unknown>();
    map.set('id', uid(label));
    map.set('type', 'text');
    map.set('x', 0);
    map.set('y', 0);
    map.set('stroke', '#000000');
    map.set('strokeWidth', 2);
    map.set('fontSize', 24);
    map.set('text', new Y.Text(label));
    map.set('z', objects.size);
    objects.set(uid(label), map);
  });
}

function objectIds(doc: Y.Doc): string[] {
  return [...doc.getMap('objects').keys()].sort();
}

describeWithDatabase('durable board storage', () => {
  let database: TestDatabase;
  let store: PostgresBoardStore;

  beforeAll(async () => {
    database = await createTestDatabase(testDatabaseUrl ?? '');
    store = new PostgresBoardStore(database.db, onSkipped);
  });

  afterAll(async () => {
    await database.drop();
  });

  async function newBoard() {
    const owner = await createUser(database.db, {
      email: `${randomUUID()}@example.com`,
      displayName: 'Owner',
      passwordHash: 'test-hash',
    });
    const board = await createBoard(database.db, { ownerId: owner.id, title: 'Durable' });
    return { owner, boardId: board.id };
  }

  async function rowCount(boardId: string): Promise<number> {
    const result = await database.db.execute<{ count: number }>(
      sql`select count(*)::int as count from yjs_document_updates where board_id = ${boardId}`,
    );
    return result.rows[0]?.count ?? 0;
  }

  it('reconstructs the complete document after a restart', async () => {
    const { owner, boardId } = await newBoard();
    const client = new Y.Doc();
    const first: BoardStore = new PostgresBoardStore(database.db, onSkipped);
    for (const label of ['a', 'b', 'c', 'd', 'e']) {
      await first.appendUpdate(boardId, owner.id, putObject(client, label));
    }

    // A new store instance stands in for a new process: nothing is cached between them.
    const afterRestart = await new PostgresBoardStore(database.db, onSkipped).load(boardId);

    expect(objectIds(afterRestart)).toEqual(idsOf('a', 'b', 'c', 'd', 'e'));
  });

  it('folds updates into a snapshot, removes the rows it covers, keeps the state', async () => {
    const { owner, boardId } = await newBoard();
    const client = new Y.Doc();
    for (const label of ['a', 'b', 'c']) {
      await store.appendUpdate(boardId, owner.id, putObject(client, label));
    }
    expect(await rowCount(boardId)).toBe(3);

    const revision = await store.compact(boardId);

    expect(revision).toMatchObject({ revision: 1, kind: 'compaction', restoredFrom: null });
    expect(await rowCount(boardId)).toBe(0);
    expect(objectIds(await store.load(boardId))).toEqual(idsOf('a', 'b', 'c'));
    expect(await store.compact(boardId)).toBeNull();
  });

  it('keeps acknowledged updates made after a compaction', async () => {
    const { owner, boardId } = await newBoard();
    const client = new Y.Doc();
    await store.appendUpdate(boardId, owner.id, putObject(client, 'before'));
    await store.compact(boardId);
    await store.appendUpdate(boardId, owner.id, putObject(client, 'after'));

    const restarted = await new PostgresBoardStore(database.db, onSkipped).load(boardId);

    expect(objectIds(restarted)).toEqual(idsOf('after', 'before'));
  });

  it('leaves the board unchanged when a compaction is interrupted before commit', async () => {
    const { owner, boardId } = await newBoard();
    const client = new Y.Doc();
    for (const label of ['x', 'y', 'z']) {
      await store.appendUpdate(boardId, owner.id, putObject(client, label));
    }

    const interrupted = store.compact(boardId, {
      beforeCommit: async () => {
        throw new Error('simulated crash before commit');
      },
    });
    await expect(interrupted).rejects.toThrow(/simulated crash/);

    expect(await rowCount(boardId)).toBe(3);
    expect(await store.listRevisions(boardId)).toEqual([]);
    expect(objectIds(await store.load(boardId))).toEqual(idsOf('x', 'y', 'z'));
  });

  it('loses no update when appends and compactions run at the same time', async () => {
    const { owner, boardId } = await newBoard();
    const labels = Array.from({ length: 40 }, (_, index) => `obj-${index}`);
    const writes = labels.map((label) =>
      store.appendUpdate(boardId, owner.id, putObject(new Y.Doc(), label)),
    );
    const compactions = Array.from({ length: 6 }, () => store.compact(boardId));

    await Promise.all([...writes, ...compactions]);

    expect(objectIds(await store.load(boardId))).toEqual(idsOf(...labels));
    expect(await store.listRevisions(boardId)).not.toHaveLength(0);
  });

  it('browses historical revisions as they were when each was taken', async () => {
    const { owner, boardId } = await newBoard();
    const client = new Y.Doc();
    await store.appendUpdate(boardId, owner.id, putObject(client, 'first'));
    await store.compact(boardId);
    await store.appendUpdate(boardId, owner.id, putObject(client, 'second'));
    await store.compact(boardId);

    const one = await store.getRevision(boardId, 1);
    const two = await store.getRevision(boardId, 2);

    expect(one.objects.map((object) => object.id)).toEqual(idsOf('first'));
    expect(two.objects.map((object) => object.id).sort()).toEqual(idsOf('first', 'second'));
    expect((await store.listRevisions(boardId)).map((meta) => meta.revision)).toEqual([1, 2]);
    expect(one.meta.createdBy).toBeNull();
  });

  it('reports an unknown revision as not found', async () => {
    const { owner, boardId } = await newBoard();

    await expect(store.getRevision(boardId, 99)).rejects.toBeInstanceOf(RevisionNotFoundError);
    await expect(store.restore(boardId, 99, owner.id)).rejects.toBeInstanceOf(
      RevisionNotFoundError,
    );
  });

  it('restores an older revision as a new current revision, and keeps the history', async () => {
    const { owner, boardId } = await newBoard();
    const client = new Y.Doc();
    await store.appendUpdate(boardId, owner.id, putObject(client, 'kept'));
    await store.compact(boardId);
    await store.appendUpdate(boardId, owner.id, putObject(client, 'later'));

    const restored = await store.restore(boardId, 1, owner.id);

    expect(restored.changed).toBe(true);
    expect(restored.revision).toMatchObject({
      revision: 2,
      kind: 'restore',
      restoredFrom: 1,
      createdBy: { id: owner.id, displayName: 'Owner' },
    });
    expect(objectIds(await store.load(boardId))).toEqual(idsOf('kept'));
    expect((await store.getRevision(boardId, 1)).objects.map((o) => o.id)).toEqual(idsOf('kept'));
    expect((await store.getRevision(boardId, 2)).objects.map((o) => o.id)).toEqual(idsOf('kept'));
  });

  it('survives a restart after a restore', async () => {
    const { owner, boardId } = await newBoard();
    const client = new Y.Doc();
    await store.appendUpdate(boardId, owner.id, putObject(client, 'old'));
    await store.compact(boardId);
    await store.appendUpdate(boardId, owner.id, putObject(client, 'new'));
    await store.restore(boardId, 1, owner.id);

    const restarted = await new PostgresBoardStore(database.db, onSkipped).load(boardId);

    expect(objectIds(restarted)).toEqual(idsOf('old'));
  });

  it('does nothing and creates no revision when the content already matches', async () => {
    const { owner, boardId } = await newBoard();
    const client = new Y.Doc();
    await store.appendUpdate(boardId, owner.id, putObject(client, 'same'));
    await store.compact(boardId);

    const result = await store.restore(boardId, 1, owner.id);

    expect(result).toEqual({ changed: false, revision: null, update: null });
    expect(await store.listRevisions(boardId)).toHaveLength(1);
  });

  it('returns the restore update, which brings a live replica to restored content', async () => {
    const { owner, boardId } = await newBoard();
    const client = new Y.Doc();
    await store.appendUpdate(boardId, owner.id, putObject(client, 'base'));
    await store.compact(boardId);
    await store.appendUpdate(boardId, owner.id, putObject(client, 'extra'));

    // A replica that already holds the current content, as a connected editor would.
    const replica = await store.load(boardId);
    const result = await store.restore(boardId, 1, owner.id);
    if (result.update) Y.applyUpdate(replica, result.update);

    expect(objectIds(replica)).toEqual(idsOf('base'));
    expect(objectIds(replica)).toEqual(objectIds(await store.load(boardId)));
  });

  it('loads a board despite an unreadable stored update, and reports it', async () => {
    const { owner, boardId } = await newBoard();
    const client = new Y.Doc();
    await store.appendUpdate(boardId, owner.id, putObject(client, 'good'));
    await database.db.execute(
      sql`insert into yjs_document_updates (board_id, author_id, payload)
        values (${boardId}, ${owner.id}, decode('ffffffff', 'hex'))`,
    );

    const loaded = await store.load(boardId);

    expect(objectIds(loaded)).toEqual(idsOf('good'));
    expect(skipped.some((entry) => entry.boardId === boardId)).toBe(true);
  });

  it('refuses writes and loads for a board that has been deleted', async () => {
    const { owner, boardId } = await newBoard();
    await database.db.execute(sql`delete from boards where id = ${boardId}`);

    await expect(
      store.appendUpdate(boardId, owner.id, putObject(new Y.Doc(), 'gone')),
    ).rejects.toBeInstanceOf(BoardNotFoundError);
    await expect(store.load(boardId)).rejects.toBeInstanceOf(BoardNotFoundError);
  });

  it('compacts every board with more updates than the threshold, and no others', async () => {
    const busy = await newBoard();
    const quiet = await newBoard();
    const client = new Y.Doc();
    for (const label of ['1', '2', '3']) {
      await store.appendUpdate(busy.boardId, busy.owner.id, putObject(client, label));
    }
    await store.appendUpdate(quiet.boardId, quiet.owner.id, putObject(new Y.Doc(), 'only'));

    const sweep = await store.compactDue(2);

    expect(sweep.failed).toEqual([]);
    expect(await rowCount(busy.boardId)).toBe(0);
    expect(await rowCount(quiet.boardId)).toBe(1);
    expect(await store.listRevisions(busy.boardId)).toHaveLength(1);
  });
});
