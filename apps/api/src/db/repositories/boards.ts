import { and, desc, eq, sql } from 'drizzle-orm';
import type { DbExecutor } from '../client';
import { firstRow } from '../rows';
import { boardMemberships, boards, type BoardRole } from '../schema';

export interface NewBoard {
  ownerId: string;
  title: string;
}

// The owner's membership row is written in the same transaction as the board, so a board
// never exists without its owner membership.
export function createBoard(db: DbExecutor, input: NewBoard) {
  return db.transaction(async (tx) => {
    const rows = await tx
      .insert(boards)
      .values({ ownerId: input.ownerId, title: input.title.trim() })
      .returning();
    const board = firstRow(rows, 'boards insert');
    await tx.insert(boardMemberships).values({
      boardId: board.id,
      userId: input.ownerId,
      role: 'owner',
    });
    return board;
  });
}

export async function findBoardById(db: DbExecutor, boardId: string) {
  const [row] = await db.select().from(boards).where(eq(boards.id, boardId)).limit(1);
  return row ?? null;
}

export async function renameBoard(db: DbExecutor, boardId: string, title: string) {
  const rows = await db
    .update(boards)
    .set({ title: title.trim() })
    .where(eq(boards.id, boardId))
    .returning();
  return rows[0] ?? null;
}

// Keyset pagination over (updated_at, id), newest first. updated_at is compared at millisecond
// precision because cursors carry JavaScript dates, so the sort key is truncated the same way.
export async function listBoardsPageForUser(
  db: DbExecutor,
  userId: string,
  options: { limit: number; after?: { updatedAt: Date; id: string } },
) {
  const sortKey = sql`date_trunc('milliseconds', ${boards.updatedAt})`;
  const after = options.after;
  const rows = await db
    .select({
      id: boards.id,
      title: boards.title,
      ownerId: boards.ownerId,
      role: boardMemberships.role,
      createdAt: boards.createdAt,
      updatedAt: boards.updatedAt,
    })
    .from(boardMemberships)
    .innerJoin(boards, eq(boards.id, boardMemberships.boardId))
    .where(
      and(
        eq(boardMemberships.userId, userId),
        after ? sql`(${sortKey}, ${boards.id}) < (${after.updatedAt}, ${after.id})` : undefined,
      ),
    )
    .orderBy(desc(sortKey), desc(boards.id))
    .limit(options.limit + 1);

  return {
    items: rows.slice(0, options.limit),
    hasMore: rows.length > options.limit,
  };
}

export async function getBoardRole(
  db: DbExecutor,
  boardId: string,
  userId: string,
): Promise<BoardRole | null> {
  const [row] = await db
    .select({ role: boardMemberships.role })
    .from(boardMemberships)
    .where(and(eq(boardMemberships.boardId, boardId), eq(boardMemberships.userId, userId)))
    .limit(1);
  return row?.role ?? null;
}

export async function deleteBoard(db: DbExecutor, boardId: string): Promise<boolean> {
  const rows = await db.delete(boards).where(eq(boards.id, boardId)).returning({ id: boards.id });
  return rows.length > 0;
}
