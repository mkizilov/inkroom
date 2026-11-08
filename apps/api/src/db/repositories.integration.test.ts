import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createBoard,
  deleteBoard,
  getBoardRole,
  listBoardsPageForUser,
} from './repositories/boards';
import {
  createSession,
  findSessionWithUserByTokenHash,
  revokeSessionByTokenHash,
} from './repositories/sessions';
import {
  appendDocumentUpdate,
  findLatestSnapshot,
  listDocumentUpdates,
  saveSnapshot,
} from './repositories/document';
import { addMember, removeMember, setMemberRole } from './repositories/memberships';
import { createUser, findUserByEmail } from './repositories/users';
import {
  createTestDatabase,
  describeWithDatabase,
  testDatabaseUrl,
  type TestDatabase,
} from './test-database';

const uniqueEmail = () => `${randomUUID()}@example.com`;

describeWithDatabase('database access modules', () => {
  let database: TestDatabase;

  const newUser = (displayName: string) =>
    createUser(database.db, { email: uniqueEmail(), displayName, passwordHash: 'test-hash' });

  beforeAll(async () => {
    database = await createTestDatabase(testDatabaseUrl ?? '');
  });

  afterAll(async () => {
    await database.drop();
  });

  it('normalizes emails on create and finds users case-insensitively', async () => {
    const email = `${randomUUID()}@Example.COM`;
    const created = await createUser(database.db, {
      email: `  ${email}  `,
      displayName: ' Ada ',
      passwordHash: 'test-hash',
    });

    expect(created.email).toBe(email.toLowerCase());
    expect(created.displayName).toBe('Ada');
    expect((await findUserByEmail(database.db, email))?.id).toBe(created.id);
    expect(await findUserByEmail(database.db, uniqueEmail())).toBeNull();
  });

  it('stores sessions by token hash and returns the owning user', async () => {
    const user = await newUser('Session');
    const tokenHash = `hash-${randomUUID()}`;
    const session = await createSession(database.db, {
      userId: user.id,
      tokenHash,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const found = await findSessionWithUserByTokenHash(database.db, tokenHash);
    expect(found?.session.id).toBe(session.id);
    expect(found?.user.id).toBe(user.id);
    expect(await findSessionWithUserByTokenHash(database.db, 'missing')).toBeNull();
  });

  it('revokes a session by token hash and keeps it findable', async () => {
    const user = await newUser('Revoked');
    const tokenHash = `hash-${randomUUID()}`;
    await createSession(database.db, {
      userId: user.id,
      tokenHash,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await revokeSessionByTokenHash(database.db, tokenHash);

    const found = await findSessionWithUserByTokenHash(database.db, tokenHash);
    expect(found?.session.revokedAt).toBeInstanceOf(Date);
  });

  it('creates a board and its owner membership together', async () => {
    const owner = await newUser('Owner');
    const board = await createBoard(database.db, { ownerId: owner.id, title: ' Planning ' });

    expect(board.title).toBe('Planning');
    expect(await getBoardRole(database.db, board.id, owner.id)).toBe('owner');
  });

  it('does not create a board when its title is invalid', async () => {
    const owner = await newUser('Owner');

    await expect(createBoard(database.db, { ownerId: owner.id, title: '   ' })).rejects.toThrow();
    expect((await listBoardsPageForUser(database.db, owner.id, { limit: 20 })).items).toHaveLength(
      0,
    );
  });

  it('lists only the boards a user is a member of, with their role', async () => {
    const owner = await newUser('Owner');
    const editor = await newUser('Editor');
    const outsider = await newUser('Other');
    const board = await createBoard(database.db, { ownerId: owner.id, title: 'Shared' });
    await createBoard(database.db, { ownerId: outsider.id, title: 'Private' });
    await addMember(database.db, { boardId: board.id, userId: editor.id, role: 'editor' });

    const { items: listed } = await listBoardsPageForUser(database.db, editor.id, { limit: 20 });

    expect(listed.map((row) => ({ id: row.id, role: row.role }))).toEqual([
      { id: board.id, role: 'editor' },
    ]);
    expect(await getBoardRole(database.db, board.id, outsider.id)).toBeNull();
  });

  it('changes member roles but never the owner role', async () => {
    const owner = await newUser('Owner');
    const member = await newUser('Member');
    const board = await createBoard(database.db, { ownerId: owner.id, title: 'Roles' });
    await addMember(database.db, { boardId: board.id, userId: member.id, role: 'viewer' });

    expect(
      await setMemberRole(database.db, { boardId: board.id, userId: member.id, role: 'editor' }),
    ).toBe(true);
    expect(await getBoardRole(database.db, board.id, member.id)).toBe('editor');

    expect(
      await setMemberRole(database.db, { boardId: board.id, userId: owner.id, role: 'viewer' }),
    ).toBe(false);
    expect(await getBoardRole(database.db, board.id, owner.id)).toBe('owner');
  });

  it('removes members but never the owner', async () => {
    const owner = await newUser('Owner');
    const member = await newUser('Member');
    const board = await createBoard(database.db, { ownerId: owner.id, title: 'Removal' });
    await addMember(database.db, { boardId: board.id, userId: member.id, role: 'editor' });

    expect(await removeMember(database.db, { boardId: board.id, userId: owner.id })).toBe(false);
    expect(await removeMember(database.db, { boardId: board.id, userId: member.id })).toBe(true);
    expect(await getBoardRole(database.db, board.id, member.id)).toBeNull();
    expect(await getBoardRole(database.db, board.id, owner.id)).toBe('owner');
  });

  it('appends document updates in order and reads them after a cursor', async () => {
    const owner = await newUser('Owner');
    const board = await createBoard(database.db, { ownerId: owner.id, title: 'Log' });

    const first = await appendDocumentUpdate(database.db, {
      boardId: board.id,
      authorId: owner.id,
      payload: Buffer.from([1, 2, 3]),
    });
    const second = await appendDocumentUpdate(database.db, {
      boardId: board.id,
      authorId: null,
      payload: Buffer.from([4, 5]),
    });

    const all = await listDocumentUpdates(database.db, board.id);
    expect(all.map((row) => row.seq)).toEqual([first, second]);
    expect(all[0]?.payload.equals(Buffer.from([1, 2, 3]))).toBe(true);

    const afterFirst = await listDocumentUpdates(database.db, board.id, first);
    expect(afterFirst.map((row) => row.seq)).toEqual([second]);
  });

  it('returns the snapshot with the highest sequence number', async () => {
    const owner = await newUser('Owner');
    const board = await createBoard(database.db, { ownerId: owner.id, title: 'Snapshots' });
    expect(await findLatestSnapshot(database.db, board.id)).toBeNull();

    await saveSnapshot(database.db, { boardId: board.id, upToSeq: 3, state: Buffer.from([9]) });
    await saveSnapshot(database.db, { boardId: board.id, upToSeq: 7, state: Buffer.from([8]) });
    await saveSnapshot(database.db, { boardId: board.id, upToSeq: 5, state: Buffer.from([7]) });

    expect((await findLatestSnapshot(database.db, board.id))?.upToSeq).toBe(7);
  });

  it('deletes a board and everything that depends on it', async () => {
    const owner = await newUser('Owner');
    const board = await createBoard(database.db, { ownerId: owner.id, title: 'Doomed' });
    await appendDocumentUpdate(database.db, {
      boardId: board.id,
      authorId: owner.id,
      payload: Buffer.from([0, 0]),
    });

    await deleteBoard(database.db, board.id);

    expect(await getBoardRole(database.db, board.id, owner.id)).toBeNull();
    expect(await listDocumentUpdates(database.db, board.id)).toHaveLength(0);
    expect((await listBoardsPageForUser(database.db, owner.id, { limit: 20 })).items).toHaveLength(
      0,
    );
  });
});
