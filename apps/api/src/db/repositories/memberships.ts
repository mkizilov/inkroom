import { and, eq, ne } from 'drizzle-orm';
import type { DbExecutor } from '../client';
import { firstRow } from '../rows';
import { boardMemberships, type MemberRole } from '../schema';

export interface MembershipKey {
  boardId: string;
  userId: string;
}

// Ownership is assigned only by createBoard. The functions below never create, change or
// remove an owner row, so every board keeps exactly one owner.
export async function addMember(
  db: DbExecutor,
  input: MembershipKey & { role: MemberRole },
) {
  const rows = await db.insert(boardMemberships).values(input).returning();
  return firstRow(rows, 'board_memberships insert');
}

export async function setMemberRole(
  db: DbExecutor,
  input: MembershipKey & { role: MemberRole },
): Promise<boolean> {
  const rows = await db
    .update(boardMemberships)
    .set({ role: input.role })
    .where(
      and(
        eq(boardMemberships.boardId, input.boardId),
        eq(boardMemberships.userId, input.userId),
        ne(boardMemberships.role, 'owner'),
      ),
    )
    .returning({ id: boardMemberships.id });
  return rows.length > 0;
}

export async function removeMember(db: DbExecutor, input: MembershipKey): Promise<boolean> {
  const rows = await db
    .delete(boardMemberships)
    .where(
      and(
        eq(boardMemberships.boardId, input.boardId),
        eq(boardMemberships.userId, input.userId),
        ne(boardMemberships.role, 'owner'),
      ),
    )
    .returning({ id: boardMemberships.id });
  return rows.length > 0;
}
