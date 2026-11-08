import { and, desc, eq } from 'drizzle-orm';
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

export function listBoardsForUser(db: DbExecutor, userId: string) {
  return db
    .select({
      id: boards.id,
      title: boards.title,
      role: boardMemberships.role,
      updatedAt: boards.updatedAt,
    })
    .from(boardMemberships)
    .innerJoin(boards, eq(boards.id, boardMemberships.boardId))
    .where(eq(boardMemberships.userId, userId))
    .orderBy(desc(boards.updatedAt), desc(boards.id));
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

export async function deleteBoard(db: DbExecutor, boardId: string): Promise<void> {
  await db.delete(boards).where(eq(boards.id, boardId));
}
