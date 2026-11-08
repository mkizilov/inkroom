import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  boardMemberships,
  boardSnapshots,
  boards,
  sessions,
  users,
  yjsDocumentUpdates,
} from './schema';
import {
  createTestDatabase,
  describeWithDatabase,
  expectSqlState,
  testDatabaseUrl,
  type TestDatabase,
} from './test-database';

const payload = Buffer.from([0, 0]);
const uniqueEmail = () => `${randomUUID()}@example.com`;

async function insertUser(db: TestDatabase['db'], displayName = 'Test user') {
  const [user] = await db
    .insert(users)
    .values({ email: uniqueEmail(), displayName, passwordHash: 'test-hash' })
    .returning();
  if (!user) throw new Error('user insert returned no row');
  return user;
}

async function insertBoard(db: TestDatabase['db'], ownerId: string, title = 'Board') {
  const [board] = await db.insert(boards).values({ ownerId, title }).returning();
  if (!board) throw new Error('board insert returned no row');
  await db.insert(boardMemberships).values({ boardId: board.id, userId: ownerId, role: 'owner' });
  return board;
}

describeWithDatabase('database schema constraints', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase(testDatabaseUrl ?? '');
  });

  afterAll(async () => {
    await database.drop();
  });

  it('creates exactly the expected application tables', async () => {
    const result = await database.db.execute<{ table_name: string }>(sql`
      select table_name from information_schema.tables
      where table_schema = ${database.schema} and table_type = 'BASE TABLE'
      order by table_name
    `);
    const names = result.rows.map((row) => row.table_name).filter((name) => !name.startsWith('__'));
    expect(names).toEqual([
      'board_memberships',
      'board_snapshots',
      'boards',
      'sessions',
      'users',
      'yjs_document_updates',
    ]);
  });

  it('rejects duplicate and non-normalized emails', async () => {
    const email = uniqueEmail();
    await database.db
      .insert(users)
      .values({ email, displayName: 'First', passwordHash: 'test-hash' });

    await expectSqlState(
      database.db
        .insert(users)
        .values({ email, displayName: 'Second', passwordHash: 'test-hash' }),
      '23505',
    );
    await expectSqlState(
      database.db
        .insert(users)
        .values({ email: email.toUpperCase(), displayName: 'Third', passwordHash: 'test-hash' }),
      '23514',
    );
  });

  it('rejects blank or overlong display names', async () => {
    await expectSqlState(
      database.db
        .insert(users)
        .values({ email: uniqueEmail(), displayName: '   ', passwordHash: 'test-hash' }),
      '23514',
    );
    await expectSqlState(
      database.db
        .insert(users)
        .values({ email: uniqueEmail(), displayName: 'x'.repeat(101), passwordHash: 'test-hash' }),
      '23514',
    );
  });

  it('requires sessions to reference a user and to have unique token hashes', async () => {
    const user = await insertUser(database.db);
    const expiresAt = new Date(Date.now() + 60_000);

    await expectSqlState(
      database.db
        .insert(sessions)
        .values({ userId: randomUUID(), tokenHash: 'hash-orphan', expiresAt }),
      '23503',
    );

    await database.db
      .insert(sessions)
      .values({ userId: user.id, tokenHash: 'hash-unique', expiresAt });
    await expectSqlState(
      database.db
        .insert(sessions)
        .values({ userId: user.id, tokenHash: 'hash-unique', expiresAt }),
      '23505',
    );
  });

  it('rejects sessions that expire before they are created', async () => {
    const user = await insertUser(database.db);
    await expectSqlState(
      database.db
        .insert(sessions)
        .values({ userId: user.id, tokenHash: 'hash-expired', expiresAt: new Date(0) }),
      '23514',
    );
  });

  it('restricts deleting a user who still owns a board', async () => {
    const owner = await insertUser(database.db);
    await insertBoard(database.db, owner.id);

    await expectSqlState(database.db.delete(users).where(eq(users.id, owner.id)), '23503');
  });

  it('rejects boards with a blank or overlong title', async () => {
    const owner = await insertUser(database.db);
    await expectSqlState(
      database.db.insert(boards).values({ ownerId: owner.id, title: '  ' }),
      '23514',
    );
    await expectSqlState(
      database.db.insert(boards).values({ ownerId: owner.id, title: 'x'.repeat(201) }),
      '23514',
    );
  });

  it('allows one membership per user per board', async () => {
    const owner = await insertUser(database.db);
    const editor = await insertUser(database.db);
    const board = await insertBoard(database.db, owner.id);

    await database.db
      .insert(boardMemberships)
      .values({ boardId: board.id, userId: editor.id, role: 'editor' });
    await expectSqlState(
      database.db
        .insert(boardMemberships)
        .values({ boardId: board.id, userId: editor.id, role: 'viewer' }),
      '23505',
    );
  });

  it('accepts only the defined membership roles', async () => {
    const owner = await insertUser(database.db);
    const other = await insertUser(database.db);
    const board = await insertBoard(database.db, owner.id);

    await expectSqlState(
      database.db.execute(sql`
        insert into board_memberships (board_id, user_id, role)
        values (${board.id}, ${other.id}, 'admin')
      `),
      '22P02',
    );
  });

  it('allows at most one owner per board', async () => {
    const owner = await insertUser(database.db);
    const second = await insertUser(database.db);
    const board = await insertBoard(database.db, owner.id);

    await expectSqlState(
      database.db
        .insert(boardMemberships)
        .values({ boardId: board.id, userId: second.id, role: 'owner' }),
      '23505',
    );
  });

  it('rejects empty or oversized document update payloads', async () => {
    const owner = await insertUser(database.db);
    const board = await insertBoard(database.db, owner.id);

    await expectSqlState(
      database.db
        .insert(yjsDocumentUpdates)
        .values({ boardId: board.id, authorId: owner.id, payload: Buffer.alloc(0) }),
      '23514',
    );
    await expectSqlState(
      database.db
        .insert(yjsDocumentUpdates)
        .values({ boardId: board.id, authorId: owner.id, payload: Buffer.alloc(1_048_577) }),
      '23514',
    );
  });

  it('assigns strictly increasing sequence numbers to document updates', async () => {
    const owner = await insertUser(database.db);
    const board = await insertBoard(database.db, owner.id);

    const inserted = await database.db
      .insert(yjsDocumentUpdates)
      .values([
        { boardId: board.id, authorId: owner.id, payload },
        { boardId: board.id, authorId: owner.id, payload },
      ])
      .returning({ seq: yjsDocumentUpdates.seq });

    expect(inserted[0]?.seq).toBeLessThan(inserted[1]?.seq ?? 0);
  });

  it('rejects snapshots with a non-positive or duplicate sequence per board', async () => {
    const owner = await insertUser(database.db);
    const board = await insertBoard(database.db, owner.id);

    await expectSqlState(
      database.db
        .insert(boardSnapshots)
        .values({ boardId: board.id, upToSeq: 0, state: payload }),
      '23514',
    );

    await database.db
      .insert(boardSnapshots)
      .values({ boardId: board.id, upToSeq: 5, state: payload });
    await expectSqlState(
      database.db
        .insert(boardSnapshots)
        .values({ boardId: board.id, upToSeq: 5, state: payload }),
      '23505',
    );
  });

  it('sets updated_at on update while keeping created_at', async () => {
    const past = new Date('2020-01-01T00:00:00Z');
    const [user] = await database.db
      .insert(users)
      .values({
        email: uniqueEmail(),
        displayName: 'Before',
        passwordHash: 'test-hash',
        createdAt: past,
        updatedAt: past,
      })
      .returning();
    if (!user) throw new Error('user insert returned no row');

    const [updated] = await database.db
      .update(users)
      .set({ displayName: 'After' })
      .where(eq(users.id, user.id))
      .returning();

    expect(updated?.createdAt).toEqual(past);
    expect(updated?.updatedAt.getTime()).toBeGreaterThan(past.getTime());
  });
});

describeWithDatabase('database cascade and deletion policies', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase(testDatabaseUrl ?? '');
  });

  afterAll(async () => {
    await database.drop();
  });

  it('removes sessions and memberships of a deleted user but keeps their boards', async () => {
    const owner = await insertUser(database.db);
    const member = await insertUser(database.db);
    const board = await insertBoard(database.db, owner.id);
    await database.db
      .insert(boardMemberships)
      .values({ boardId: board.id, userId: member.id, role: 'editor' });
    await database.db.insert(sessions).values({
      userId: member.id,
      tokenHash: `hash-${randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await database.db.delete(users).where(eq(users.id, member.id));

    const remainingMemberships = await database.db
      .select()
      .from(boardMemberships)
      .where(eq(boardMemberships.userId, member.id));
    const remainingSessions = await database.db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, member.id));
    const remainingBoards = await database.db.select().from(boards).where(eq(boards.id, board.id));

    expect(remainingMemberships).toHaveLength(0);
    expect(remainingSessions).toHaveLength(0);
    expect(remainingBoards).toHaveLength(1);
  });

  it('nulls the author of document updates when the author is deleted', async () => {
    const owner = await insertUser(database.db);
    const author = await insertUser(database.db);
    const board = await insertBoard(database.db, owner.id);
    const [update] = await database.db
      .insert(yjsDocumentUpdates)
      .values({ boardId: board.id, authorId: author.id, payload })
      .returning();
    if (!update) throw new Error('update insert returned no row');

    await database.db.delete(users).where(eq(users.id, author.id));

    const [after] = await database.db
      .select()
      .from(yjsDocumentUpdates)
      .where(eq(yjsDocumentUpdates.id, update.id));
    expect(after?.authorId).toBeNull();
  });

  it('removes memberships, document updates and snapshots when a board is deleted', async () => {
    const owner = await insertUser(database.db);
    const member = await insertUser(database.db);
    const board = await insertBoard(database.db, owner.id);
    await database.db
      .insert(boardMemberships)
      .values({ boardId: board.id, userId: member.id, role: 'viewer' });
    await database.db
      .insert(yjsDocumentUpdates)
      .values({ boardId: board.id, authorId: owner.id, payload });
    await database.db
      .insert(boardSnapshots)
      .values({ boardId: board.id, upToSeq: 1, state: payload });

    await database.db.delete(boards).where(eq(boards.id, board.id));

    expect(
      await database.db.select().from(boardMemberships).where(eq(boardMemberships.boardId, board.id)),
    ).toHaveLength(0);
    expect(
      await database.db
        .select()
        .from(yjsDocumentUpdates)
        .where(eq(yjsDocumentUpdates.boardId, board.id)),
    ).toHaveLength(0);
    expect(
      await database.db.select().from(boardSnapshots).where(eq(boardSnapshots.boardId, board.id)),
    ).toHaveLength(0);
    expect(await database.db.select().from(users).where(eq(users.id, owner.id))).toHaveLength(
      1,
    );
  });
});
