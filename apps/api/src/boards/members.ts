import { eq, sql } from 'drizzle-orm';
import type { BoardRole, Member } from '@inkroom/shared';
import type { DbExecutor } from '../db/client';
import { getBoardRole } from '../db/repositories/boards';
import {
  addMember,
  removeMember as deleteMembership,
  setMemberRole,
} from '../db/repositories/memberships';
import { boardMemberships, users, type MemberRole } from '../db/schema';
import { AppError } from '../http/errors';

// Membership changes. Each one takes the board's row lock, the same lock writes take, so a change
// is ordered against every write: a write that commits after a revocation is refused by the
// database. The owner's own membership is never changed or removed here, so a board always has an
// owner.

const ROLE_ORDER: Record<BoardRole, number> = { owner: 0, editor: 1, viewer: 2 };

async function lockBoard(exec: DbExecutor, boardId: string): Promise<void> {
  const result = await exec.execute<{ id: string }>(
    sql`select id from boards where id = ${boardId} for update`,
  );
  if (result.rows.length === 0) {
    throw new AppError(404, 'board_not_found', 'Board not found.');
  }
}

// Everyone with access. Email addresses are included only for the owner.
export async function listMembers(
  db: DbExecutor,
  boardId: string,
  viewerRole: BoardRole,
): Promise<Member[]> {
  const rows = await db
    .select({
      userId: boardMemberships.userId,
      role: boardMemberships.role,
      displayName: users.displayName,
      email: users.email,
    })
    .from(boardMemberships)
    .innerJoin(users, eq(users.id, boardMemberships.userId))
    .where(eq(boardMemberships.boardId, boardId));
  return rows
    .map((row) => ({
      userId: row.userId,
      displayName: row.displayName,
      role: row.role,
      email: viewerRole === 'owner' ? row.email : null,
    }))
    .sort(
      (a, b) =>
        ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.displayName.localeCompare(b.displayName),
    );
}

// Grants access to a registered user. The address must belong to an account; there is no invitation
// for people who have not signed up. The address arrives normalized from the request schema.
export function inviteMember(
  db: DbExecutor,
  boardId: string,
  email: string,
  role: MemberRole,
): Promise<Member> {
  return db.transaction(async (tx) => {
    await lockBoard(tx, boardId);
    const [user] = await tx
      .select({ id: users.id, email: users.email, displayName: users.displayName })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (!user) {
      throw new AppError(404, 'user_not_found', 'No account exists for that email address.');
    }
    if (await getBoardRole(tx, boardId, user.id)) {
      throw new AppError(409, 'already_member', 'That user already has access to this board.');
    }
    await addMember(tx, { boardId, userId: user.id, role });
    return { userId: user.id, displayName: user.displayName, role, email: user.email };
  });
}

export function changeMemberRole(
  db: DbExecutor,
  boardId: string,
  userId: string,
  role: MemberRole,
): Promise<Member> {
  return db.transaction(async (tx) => {
    await lockBoard(tx, boardId);
    const current = await getBoardRole(tx, boardId, userId);
    if (!current) {
      throw new AppError(404, 'member_not_found', 'That user is not a member of this board.');
    }
    if (current === 'owner') {
      throw new AppError(409, 'owner_role_fixed', 'The role of the board owner cannot change.');
    }
    await setMemberRole(tx, { boardId, userId, role });
    const [user] = await tx
      .select({ email: users.email, displayName: users.displayName })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return {
      userId,
      displayName: user?.displayName ?? '',
      role,
      email: user?.email ?? null,
    };
  });
}

export function removeMember(db: DbExecutor, boardId: string, userId: string): Promise<void> {
  return db.transaction(async (tx) => {
    await lockBoard(tx, boardId);
    const current = await getBoardRole(tx, boardId, userId);
    if (!current) {
      throw new AppError(404, 'member_not_found', 'That user is not a member of this board.');
    }
    if (current === 'owner') {
      throw new AppError(409, 'owner_cannot_leave', 'The owner cannot leave or be removed.');
    }
    await deleteMembership(tx, { boardId, userId });
  });
}
