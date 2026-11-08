import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../app';
import { issueSession } from '../auth/service';
import { createBoard } from '../db/repositories/boards';
import { addMember } from '../db/repositories/memberships';
import { createUser } from '../db/repositories/users';
import {
  createTestDatabase,
  describeWithDatabase,
  testDatabaseUrl,
  type TestDatabase,
} from '../db/test-database';
import { PostgresBoardStore } from '../persistence/store';

const WEB_ORIGIN = 'http://127.0.0.1:21173';
const uid = (label: string) =>
  `00000000-0000-4000-8000-${Buffer.from(label).toString('hex').padStart(12, '0')}`;

function putObject(client: Y.Doc, label: string): Uint8Array {
  const updates: Uint8Array[] = [];
  const record = (update: Uint8Array) => updates.push(update);
  client.on('update', record);
  client.transact(() => {
    const objects = client.getMap<Y.Map<unknown>>('objects');
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
  client.off('update', record);
  return Y.mergeUpdates(updates);
}

interface Member {
  id: string;
  cookie: string;
}

type LightMyRequestResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

describeWithDatabase('board revisions over HTTP', () => {
  let database: TestDatabase;
  let app: FastifyInstance;
  let store: PostgresBoardStore;
  let boardId: string;
  let owner: Member;
  let editor: Member;
  let viewer: Member;
  let stranger: Member;

  beforeAll(async () => {
    database = await createTestDatabase(testDatabaseUrl ?? '');
    ({ app } = await buildApp({
      database,
      webOrigin: WEB_ORIGIN,
      cookieSecure: false,
      startHeartbeat: false,
    }));
    store = new PostgresBoardStore(database.db, () => undefined);

    const member = async (name: string): Promise<Member> => {
      const user = await createUser(database.db, {
        email: `${randomUUID()}@example.com`,
        displayName: name,
        passwordHash: 'test-hash',
      });
      const token = await issueSession(database.db, user.id);
      return { id: user.id, cookie: `inkroom_session=${token}` };
    };
    owner = await member('Owner');
    editor = await member('Editor');
    viewer = await member('Viewer');
    stranger = await member('Stranger');

    const board = await createBoard(database.db, { ownerId: owner.id, title: 'History' });
    boardId = board.id;
    await addMember(database.db, { boardId, userId: editor.id, role: 'editor' });
    await addMember(database.db, { boardId, userId: viewer.id, role: 'viewer' });

    // Revision 1 holds "first"; revision 2 holds "first" and "second".
    const client = new Y.Doc();
    await store.appendUpdate(boardId, owner.id, putObject(client, 'first'));
    await store.compact(boardId);
    await store.appendUpdate(boardId, owner.id, putObject(client, 'second'));
    await store.compact(boardId);
  });

  afterAll(async () => {
    await app.close();
    await database.drop();
  });

  function call(
    method: InjectOptions['method'],
    url: string,
    as?: Member,
    headers: Record<string, string> = {},
  ): Promise<LightMyRequestResponse> {
    return app.inject({
      method,
      url,
      headers: { origin: WEB_ORIGIN, ...(as ? { cookie: as.cookie } : {}), ...headers },
    });
  }

  const json = (response: LightMyRequestResponse): Record<string, unknown> =>
    response.json() as Record<string, unknown>;

  it('lists the revisions for any member', async () => {
    const response = await call('GET', `/api/boards/${boardId}/revisions`, viewer);

    expect(response.statusCode).toBe(200);
    const items = json(response).items as Array<{ revision: number; kind: string }>;
    expect(items.map((item) => [item.revision, item.kind])).toEqual([
      [1, 'compaction'],
      [2, 'compaction'],
    ]);
  });

  it('shows a revision with its objects to a viewer', async () => {
    const response = await call('GET', `/api/boards/${boardId}/revisions/1`, viewer);

    expect(response.statusCode).toBe(200);
    const objects = json(response).objects as Array<{ id: string }>;
    expect(objects.map((object) => object.id)).toEqual([uid('first')]);
  });

  it('returns 404 to non-members and for unknown revisions', async () => {
    const outsider = await call('GET', `/api/boards/${boardId}/revisions`, stranger);
    const unknown = await call('GET', `/api/boards/${boardId}/revisions/99`, owner);

    expect(outsider.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(json(unknown)).toMatchObject({ error: { code: 'revision_not_found' } });
  });

  it('rejects a malformed revision number with a validation error', async () => {
    const response = await call('GET', `/api/boards/${boardId}/revisions/abc`, owner);

    expect(response.statusCode).toBe(400);
    expect(json(response)).toMatchObject({ error: { code: 'validation_failed' } });
  });

  it('forbids editors and viewers from restoring, and leaves the content unchanged', async () => {
    const byEditor = await call('POST', `/api/boards/${boardId}/revisions/1/restore`, editor);
    const byViewer = await call('POST', `/api/boards/${boardId}/revisions/1/restore`, viewer);

    expect(byEditor.statusCode).toBe(403);
    expect(byViewer.statusCode).toBe(403);
    expect(json(byViewer)).toMatchObject({ error: { code: 'forbidden' } });
    const current = await store.load(boardId);
    expect([...current.getMap('objects').keys()].sort()).toEqual(
      [uid('first'), uid('second')].sort(),
    );
  });

  it('refuses a restore that arrives from another site', async () => {
    const response = await call('POST', `/api/boards/${boardId}/revisions/1/restore`, owner, {
      origin: 'https://evil.example',
    });

    expect(response.statusCode).toBe(403);
    expect(json(response)).toMatchObject({ error: { code: 'csrf_origin_rejected' } });
  });

  it('lets the owner restore an older revision as a new current revision', async () => {
    const response = await call('POST', `/api/boards/${boardId}/revisions/1/restore`, owner);

    expect(response.statusCode).toBe(201);
    const body = json(response) as {
      changed: boolean;
      revision: { revision: number; kind: string; restoredFrom: number };
    };
    expect(body.changed).toBe(true);
    expect(body.revision).toMatchObject({ revision: 3, kind: 'restore', restoredFrom: 1 });

    const current = await store.load(boardId);
    expect([...current.getMap('objects').keys()]).toEqual([uid('first')]);
  });

  it('reports no change when the owner restores the content that is already current', async () => {
    const response = await call('POST', `/api/boards/${boardId}/revisions/1/restore`, owner);

    expect(response.statusCode).toBe(200);
    expect(json(response)).toEqual({ changed: false, revision: null });
  });
});
