import { randomUUID } from 'node:crypto';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, expect, it } from 'vitest';
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

const WEB_ORIGIN = 'http://127.0.0.1:21173';

interface Member {
  id: string;
  email: string;
  cookie: string;
}

interface Item {
  userId: string;
  role: string;
  email: string | null;
}

type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

describeWithDatabase('sharing and membership over HTTP', () => {
  let database: TestDatabase;
  let app: FastifyInstance;
  let owner: Member;
  let editor: Member;
  let viewer: Member;
  let stranger: Member;
  let newcomer: Member;
  let boardId: string;

  beforeAll(async () => {
    database = await createTestDatabase(testDatabaseUrl ?? '');
    ({ app } = await buildApp({
      database,
      webOrigin: WEB_ORIGIN,
      cookieSecure: false,
      startHeartbeat: false,
    }));

    const member = async (name: string): Promise<Member> => {
      const email = `${randomUUID()}@example.com`;
      const user = await createUser(database.db, {
        email,
        displayName: name,
        passwordHash: 'test-hash',
      });
      const token = await issueSession(database.db, user.id);
      return { id: user.id, email, cookie: `inkroom_session=${token}` };
    };
    owner = await member('Owner');
    editor = await member('Editor');
    viewer = await member('Viewer');
    stranger = await member('Stranger');
    newcomer = await member('Newcomer');

    const board = await createBoard(database.db, { ownerId: owner.id, title: 'Shared' });
    boardId = board.id;
    await addMember(database.db, { boardId, userId: editor.id, role: 'editor' });
    await addMember(database.db, { boardId, userId: viewer.id, role: 'viewer' });
  });

  afterAll(async () => {
    await app.close();
    await database.drop();
  });

  function call(
    method: InjectOptions['method'],
    url: string,
    as?: Member,
    payload?: object,
  ): Promise<InjectResponse> {
    return app.inject({
      method,
      url,
      payload,
      headers: { origin: WEB_ORIGIN, ...(as ? { cookie: as.cookie } : {}) },
    });
  }

  const json = (response: InjectResponse) => response.json() as Record<string, unknown>;
  const itemsOf = (response: InjectResponse): Item[] => (json(response).items ?? []) as Item[];
  const boardPath = () => `/api/boards/${boardId}`;
  const membersPath = () => `${boardPath()}/members`;
  const memberPath = (userId: string) => `${membersPath()}/${userId}`;

  it('lets the owner invite a registered user, who then has the granted role', async () => {
    const response = await call('POST', membersPath(), owner, {
      email: newcomer.email.toUpperCase(),
      role: 'editor',
    });
    const asNewcomer = await call('GET', boardPath(), newcomer);

    expect(response.statusCode).toBe(201);
    expect(json(response).member).toMatchObject({
      userId: newcomer.id,
      role: 'editor',
      email: newcomer.email,
    });
    expect(asNewcomer.statusCode).toBe(200);
    expect(json(asNewcomer).board).toMatchObject({ id: boardId, role: 'editor' });
  });

  it('refuses to invite an address that has no account', async () => {
    const response = await call('POST', membersPath(), owner, {
      email: `nobody-${randomUUID()}@example.com`,
      role: 'viewer',
    });

    expect(response.statusCode).toBe(404);
    expect(json(response)).toMatchObject({ error: { code: 'user_not_found' } });
  });

  it('refuses to invite someone who is already a member', async () => {
    const response = await call('POST', membersPath(), owner, {
      email: editor.email,
      role: 'viewer',
    });

    expect(response.statusCode).toBe(409);
    expect(json(response)).toMatchObject({ error: { code: 'already_member' } });
  });

  it('cannot grant ownership through an invitation or a role change', async () => {
    const invite = await call('POST', membersPath(), owner, {
      email: stranger.email,
      role: 'owner',
    });
    const change = await call('PATCH', memberPath(viewer.id), owner, { role: 'owner' });

    expect(invite.statusCode).toBe(400);
    expect(change.statusCode).toBe(400);
  });

  it('refuses a cross-site invitation before any other check', async () => {
    const response = await app.inject({
      method: 'POST',
      url: membersPath(),
      payload: { email: stranger.email, role: 'viewer' },
      headers: { origin: 'https://evil.example', cookie: owner.cookie },
    });
    const list = itemsOf(await call('GET', membersPath(), owner));

    expect(response.statusCode).toBe(403);
    expect(list.map((item) => item.userId)).not.toContain(stranger.id);
  });

  it('lets only the owner invite, change roles and remove other members', async () => {
    const byEditor = await call('POST', membersPath(), editor, {
      email: stranger.email,
      role: 'viewer',
    });
    const byViewer = await call('POST', membersPath(), viewer, {
      email: stranger.email,
      role: 'viewer',
    });
    const roleByEditor = await call('PATCH', memberPath(viewer.id), editor, { role: 'editor' });
    const removeByEditor = await call('DELETE', memberPath(viewer.id), editor);
    const byStranger = await call('POST', membersPath(), stranger, {
      email: stranger.email,
      role: 'viewer',
    });

    expect(byEditor.statusCode).toBe(403);
    expect(byViewer.statusCode).toBe(403);
    expect(roleByEditor.statusCode).toBe(403);
    expect(removeByEditor.statusCode).toBe(403);
    expect(byStranger.statusCode).toBe(404);
  });

  it('lets only members see the member list, and not anonymous callers', async () => {
    const asViewer = await call('GET', membersPath(), viewer);
    const asStranger = await call('GET', membersPath(), stranger);
    const anonymous = await call('GET', membersPath());

    expect(asViewer.statusCode).toBe(200);
    expect(asStranger.statusCode).toBe(404);
    expect(anonymous.statusCode).toBe(401);
  });

  it('shows emails only to the owner', async () => {
    const asOwner = itemsOf(await call('GET', membersPath(), owner));
    const asViewer = itemsOf(await call('GET', membersPath(), viewer));

    expect(asOwner.length).toBeGreaterThan(0);
    expect(asOwner.every((item) => item.email !== null)).toBe(true);
    expect(asViewer.every((item) => item.email === null)).toBe(true);
  });

  it('keeps the board itself out of reach of viewers and editors', async () => {
    const viewerRename = await call('PATCH', boardPath(), viewer, { title: 'Nope' });
    const viewerDelete = await call('DELETE', boardPath(), viewer);
    const editorDelete = await call('DELETE', boardPath(), editor);
    const after = await call('GET', boardPath(), owner);

    expect(viewerRename.statusCode).toBe(403);
    expect(viewerDelete.statusCode).toBe(403);
    expect(editorDelete.statusCode).toBe(403);
    expect(json(after).board).toMatchObject({ title: 'Shared' });
  });

  it('applies a role change on the member’s next request', async () => {
    const demoted = await call('PATCH', memberPath(editor.id), owner, { role: 'viewer' });
    const rename = await call('PATCH', boardPath(), editor, { title: 'Hacked' });
    const restored = await call('PATCH', memberPath(editor.id), owner, { role: 'editor' });

    expect(demoted.statusCode).toBe(200);
    expect(json(demoted).member).toMatchObject({ role: 'viewer' });
    expect(rename.statusCode).toBe(403);
    expect(restored.statusCode).toBe(200);
  });

  it('will not change the owner’s role', async () => {
    const response = await call('PATCH', memberPath(owner.id), owner, { role: 'viewer' });

    expect(response.statusCode).toBe(409);
    expect(json(response)).toMatchObject({ error: { code: 'owner_role_fixed' } });
  });

  it('removes a member, who then cannot see the board or its member list', async () => {
    const removed = await call('DELETE', memberPath(viewer.id), owner);
    const board = await call('GET', boardPath(), viewer);
    const list = await call('GET', membersPath(), viewer);

    expect(removed.statusCode).toBe(204);
    expect(board.statusCode).toBe(404);
    expect(list.statusCode).toBe(404);
  });

  it('lets a member leave on their own, but not the owner', async () => {
    const leave = await call('DELETE', memberPath(editor.id), editor);
    const after = await call('GET', boardPath(), editor);
    const ownerLeaves = await call('DELETE', memberPath(owner.id), owner);

    expect(leave.statusCode).toBe(204);
    expect(after.statusCode).toBe(404);
    expect(ownerLeaves.statusCode).toBe(409);
    expect(json(ownerLeaves)).toMatchObject({ error: { code: 'owner_cannot_leave' } });
  });

  it('refuses a stranger’s attempt to remove the owner, with the same answer as a missing board', async () => {
    const response = await call('DELETE', memberPath(owner.id), stranger);

    expect(response.statusCode).toBe(404);
  });

  it('reports a missing member as not found when the owner removes them', async () => {
    const response = await call('DELETE', memberPath(randomUUID()), owner);

    expect(response.statusCode).toBe(404);
    expect(json(response)).toMatchObject({ error: { code: 'member_not_found' } });
  });
});
