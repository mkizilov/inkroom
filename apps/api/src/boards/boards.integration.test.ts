import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { issueSession } from '../auth/service';
import { addMember } from '../db/repositories/memberships';
import { createUser } from '../db/repositories/users';
import { boards } from '../db/schema';
import {
  createTestDatabase,
  describeWithDatabase,
  testDatabaseUrl,
  type TestDatabase,
} from '../db/test-database';

const WEB_ORIGIN = 'http://127.0.0.1:21173';
const uniqueEmail = () => `${randomUUID()}@example.com`;

interface Account {
  id: string;
  cookie: string;
}

interface BoardJson {
  id: string;
  title: string;
  ownerId: string;
  role: 'owner' | 'editor' | 'viewer';
  createdAt: string;
  updatedAt: string;
}

interface PageJson {
  items: BoardJson[];
  nextCursor: string | null;
}

type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

function body<T>(response: InjectResponse): T {
  return response.json() as T;
}

describeWithDatabase('board management API', () => {
  let database: TestDatabase;
  let app: FastifyInstance;

  beforeAll(async () => {
    database = await createTestDatabase(testDatabaseUrl ?? '');
    ({ app } = await buildApp({
      database,
      webOrigin: WEB_ORIGIN,
      cookieSecure: false,
      startHeartbeat: false,
    }));
  });

  afterAll(async () => {
    await app.close();
    await database.drop();
  });

  async function account(displayName: string): Promise<Account> {
    const user = await createUser(database.db, {
      email: uniqueEmail(),
      displayName,
      passwordHash: 'test-hash',
    });
    const token = await issueSession(database.db, user.id);
    return { id: user.id, cookie: `inkroom_session=${token}` };
  }

  function call(method: InjectOptions['method'], url: string, as?: Account, payload?: object) {
    return app.inject({
      method,
      url,
      payload,
      headers: { origin: WEB_ORIGIN, ...(as ? { cookie: as.cookie } : {}) },
    });
  }

  async function createBoardAs(as: Account, title: string): Promise<BoardJson> {
    const response = await call('POST', '/api/boards', as, { title });
    expect(response.statusCode).toBe(201);
    return body<{ board: BoardJson }>(response).board;
  }

  async function shareBoard(board: BoardJson, member: Account, role: 'editor' | 'viewer') {
    await addMember(database.db, { boardId: board.id, userId: member.id, role });
  }

  // Lets a test control updated_at, which the update trigger otherwise overwrites with now().
  async function withTriggerDisabled(fn: () => Promise<void>) {
    await database.db.execute(sql`alter table boards disable trigger boards_set_updated_at`);
    try {
      await fn();
    } finally {
      await database.db.execute(sql`alter table boards enable trigger boards_set_updated_at`);
    }
  }

  // Follows nextCursor until it runs out, returning every item id in page order.
  async function collectAllPages(as: Account, pageSize: number): Promise<string[]> {
    const ids: string[] = [];
    let url = `/api/boards?limit=${pageSize}`;
    for (let guard = 0; guard < 50; guard += 1) {
      const page = body<PageJson>(await call('GET', url, as));
      ids.push(...page.items.map((item) => item.id));
      if (!page.nextCursor) {
        return ids;
      }
      url = `/api/boards?limit=${pageSize}&cursor=${encodeURIComponent(page.nextCursor)}`;
    }
    throw new Error('pagination did not terminate');
  }

  describe('creating and listing boards', () => {
    it('creates a board owned by the caller and lists it with the owner role', async () => {
      const owner = await account('Owner');

      const board = await createBoardAs(owner, '  Sprint planning  ');

      expect(board).toMatchObject({ title: 'Sprint planning', ownerId: owner.id, role: 'owner' });
      expect(Number.isNaN(Date.parse(board.createdAt))).toBe(false);

      const list = await call('GET', '/api/boards', owner);
      expect(list.statusCode).toBe(200);
      expect(body<PageJson>(list).items).toEqual([board]);
    });

    it('rejects unauthenticated creation and blank titles', async () => {
      const owner = await account('Validator');

      const anonymous = await call('POST', '/api/boards', undefined, { title: 'Nope' });
      const blank = await call('POST', '/api/boards', owner, { title: '   ' });

      expect(anonymous.statusCode).toBe(401);
      expect(body(anonymous)).toMatchObject({ error: { code: 'unauthenticated' } });
      expect(blank.statusCode).toBe(400);
      expect(body(blank)).toMatchObject({
        error: {
          code: 'validation_failed',
          details: [{ field: 'title', message: 'Enter a board name.' }],
        },
      });
    });

    it('lists only boards the caller is a member of', async () => {
      const owner = await account('Lister owner');
      const editor = await account('Lister editor');
      const outsider = await account('Lister outsider');
      const shared = await createBoardAs(owner, 'Shared');
      await shareBoard(shared, editor, 'editor');
      await createBoardAs(outsider, 'Private');

      const editorItems = body<PageJson>(await call('GET', '/api/boards', editor)).items;
      const outsiderItems = body<PageJson>(await call('GET', '/api/boards', outsider)).items;

      expect(editorItems).toMatchObject([{ id: shared.id, role: 'editor' }]);
      expect(outsiderItems.map((item) => item.title)).toEqual(['Private']);
    });

    it('pages through every board exactly once with opaque cursors', async () => {
      const owner = await account('Pager');
      const created: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        created.push((await createBoardAs(owner, `Page ${index}`)).id);
      }

      const pageOne = body<PageJson>(await call('GET', '/api/boards?limit=2', owner));
      expect(pageOne.items).toHaveLength(2);
      expect(pageOne.nextCursor).toEqual(expect.any(String));

      const seen = await collectAllPages(owner, 2);
      expect(seen).toHaveLength(5);
      expect(new Set(seen)).toEqual(new Set(created));
    });

    it('does not skip or repeat boards that share the same updated_at', async () => {
      const owner = await account('Tie breaker');
      const created: string[] = [];
      for (let index = 0; index < 4; index += 1) {
        created.push((await createBoardAs(owner, `Tie ${index}`)).id);
      }
      await withTriggerDisabled(async () => {
        await database.db
          .update(boards)
          .set({ updatedAt: new Date('2026-06-01T12:00:00.000Z') })
          .where(eq(boards.ownerId, owner.id));
      });

      const seen = await collectAllPages(owner, 1);

      expect(seen).toHaveLength(4);
      expect(new Set(seen)).toEqual(new Set(created));
    });

    it('returns at most 20 boards by default and a cursor when more remain', async () => {
      const owner = await account('Default page');
      for (let index = 0; index < 21; index += 1) {
        await createBoardAs(owner, `Board ${index}`);
      }

      const page = body<PageJson>(await call('GET', '/api/boards', owner));

      expect(page.items).toHaveLength(20);
      expect(page.nextCursor).toEqual(expect.any(String));
    });

    it('rejects invalid page sizes and cursors with 400', async () => {
      const owner = await account('Bad paging');

      const responses = await Promise.all([
        call('GET', '/api/boards?limit=0', owner),
        call('GET', '/api/boards?limit=101', owner),
        call('GET', '/api/boards?limit=many', owner),
        call('GET', '/api/boards?cursor=garbage%21', owner),
      ]);

      for (const response of responses) {
        expect(response.statusCode).toBe(400);
        expect(body(response)).toMatchObject({ error: { code: 'validation_failed' } });
      }
    });
  });

  describe('board metadata', () => {
    it('returns the board with the caller role for every member role', async () => {
      const owner = await account('Meta owner');
      const editor = await account('Meta editor');
      const viewer = await account('Meta viewer');
      const board = await createBoardAs(owner, 'Metadata');
      await shareBoard(board, editor, 'editor');
      await shareBoard(board, viewer, 'viewer');

      const roles = await Promise.all(
        [owner, editor, viewer].map(async (as) => {
          const response = await call('GET', `/api/boards/${board.id}`, as);
          return body<{ board: BoardJson }>(response).board;
        }),
      );

      expect(roles.map((item) => [item.title, item.role])).toEqual([
        ['Metadata', 'owner'],
        ['Metadata', 'editor'],
        ['Metadata', 'viewer'],
      ]);
    });

    it('hides boards from non-members, so missing and forbidden look the same', async () => {
      const owner = await account('Hidden owner');
      const stranger = await account('Stranger');
      const board = await createBoardAs(owner, 'Confidential');

      const forbidden = await call('GET', `/api/boards/${board.id}`, stranger);
      const missing = await call('GET', `/api/boards/${randomUUID()}`, stranger);

      expect(forbidden.statusCode).toBe(404);
      expect(body(forbidden)).toMatchObject({ error: { code: 'board_not_found' } });
      expect(body(missing)).toEqual(body(forbidden));
    });

    it('rejects malformed board ids and unauthenticated reads', async () => {
      const owner = await account('Id checker');
      const board = await createBoardAs(owner, 'Ids');

      const malformed = await call('GET', '/api/boards/not-a-uuid', owner);
      const anonymous = await call('GET', `/api/boards/${board.id}`);

      expect(malformed.statusCode).toBe(400);
      expect(body(malformed)).toMatchObject({
        error: { code: 'validation_failed', details: [{ field: 'boardId' }] },
      });
      expect(anonymous.statusCode).toBe(401);
    });
  });

  describe('renaming boards', () => {
    it('lets owners and editors rename and refreshes updated_at', async () => {
      const owner = await account('Renamer owner');
      const editor = await account('Renamer editor');
      const board = await createBoardAs(owner, 'Old name');
      await shareBoard(board, editor, 'editor');

      const byOwner = await call('PATCH', `/api/boards/${board.id}`, owner, {
        title: 'Owner name',
      });
      const byEditor = await call('PATCH', `/api/boards/${board.id}`, editor, {
        title: 'Editor name',
      });

      expect(byOwner.statusCode).toBe(200);
      expect(body<{ board: BoardJson }>(byOwner).board).toMatchObject({
        title: 'Owner name',
        role: 'owner',
      });
      const renamedByEditor = body<{ board: BoardJson }>(byEditor).board;
      expect(renamedByEditor).toMatchObject({ title: 'Editor name', role: 'editor' });
      expect(Date.parse(renamedByEditor.updatedAt)).toBeGreaterThanOrEqual(
        Date.parse(board.updatedAt),
      );
    });

    it('forbids viewers from renaming and leaves the title unchanged', async () => {
      const owner = await account('Viewer owner');
      const viewer = await account('Viewer');
      const board = await createBoardAs(owner, 'Locked');
      await shareBoard(board, viewer, 'viewer');

      const response = await call('PATCH', `/api/boards/${board.id}`, viewer, {
        title: 'Hacked',
      });
      const current = await call('GET', `/api/boards/${board.id}`, owner);

      expect(response.statusCode).toBe(403);
      expect(body(response)).toMatchObject({ error: { code: 'forbidden' } });
      expect(body<{ board: BoardJson }>(current).board.title).toBe('Locked');
    });

    it('hides the board from non-members and validates the new title', async () => {
      const owner = await account('Rename validation owner');
      const stranger = await account('Rename stranger');
      const board = await createBoardAs(owner, 'Valid');

      const strangerResponse = await call('PATCH', `/api/boards/${board.id}`, stranger, {
        title: 'Taken',
      });
      const blank = await call('PATCH', `/api/boards/${board.id}`, owner, { title: '' });

      expect(strangerResponse.statusCode).toBe(404);
      expect(blank.statusCode).toBe(400);
      expect(body(blank)).toMatchObject({
        error: { details: [{ field: 'title', message: 'Enter a board name.' }] },
      });
    });
  });

  describe('deleting boards', () => {
    it('lets only the owner delete a board, which then disappears for everyone', async () => {
      const owner = await account('Deleter owner');
      const editor = await account('Deleter editor');
      const viewer = await account('Deleter viewer');
      const board = await createBoardAs(owner, 'Doomed');
      await shareBoard(board, editor, 'editor');
      await shareBoard(board, viewer, 'viewer');

      const byEditor = await call('DELETE', `/api/boards/${board.id}`, editor);
      const byViewer = await call('DELETE', `/api/boards/${board.id}`, viewer);
      expect(byEditor.statusCode).toBe(403);
      expect(body(byEditor)).toMatchObject({ error: { code: 'forbidden' } });
      expect(byViewer.statusCode).toBe(403);

      const byOwner = await call('DELETE', `/api/boards/${board.id}`, owner);
      expect(byOwner.statusCode).toBe(204);

      const afterOwner = await call('GET', `/api/boards/${board.id}`, owner);
      const editorItems = body<PageJson>(await call('GET', '/api/boards', editor)).items;
      expect(afterOwner.statusCode).toBe(404);
      expect(editorItems).toEqual([]);
    });

    it('returns 404 for non-members and for boards that were already deleted', async () => {
      const owner = await account('Double delete owner');
      const stranger = await account('Double delete stranger');
      const board = await createBoardAs(owner, 'Gone soon');

      const strangerResponse = await call('DELETE', `/api/boards/${board.id}`, stranger);
      expect(strangerResponse.statusCode).toBe(404);

      await call('DELETE', `/api/boards/${board.id}`, owner);
      const again = await call('DELETE', `/api/boards/${board.id}`, owner);
      expect(again.statusCode).toBe(404);
      expect(body(again)).toMatchObject({ error: { code: 'board_not_found' } });
    });

    it('rejects cross-site deletes before any authorization check', async () => {
      const owner = await account('Csrf owner');
      const board = await createBoardAs(owner, 'Protected');

      const response = await app.inject({
        method: 'DELETE',
        url: `/api/boards/${board.id}`,
        headers: { origin: 'https://evil.example', cookie: owner.cookie },
      });
      const stillThere = await call('GET', `/api/boards/${board.id}`, owner);

      expect(response.statusCode).toBe(403);
      expect(body(response)).toMatchObject({ error: { code: 'csrf_origin_rejected' } });
      expect(stillThere.statusCode).toBe(200);
    });

    it('requires authentication to delete', async () => {
      const owner = await account('Anonymous delete owner');
      const board = await createBoardAs(owner, 'Still here');

      const response = await call('DELETE', `/api/boards/${board.id}`);

      expect(response.statusCode).toBe(401);
    });
  });
});
