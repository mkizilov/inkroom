import type { BoardRole } from '@inkroom/shared';
import type { DbExecutor } from '../db/client';
import { getBoardRole } from '../db/repositories/boards';
import { AppError } from '../http/errors';

export type BoardAction = 'read' | 'rename' | 'delete' | 'restore' | 'manage_members';

const allowedRoles: Record<BoardAction, readonly BoardRole[]> = {
  read: ['owner', 'editor', 'viewer'],
  rename: ['owner', 'editor'],
  delete: ['owner'],
  // Restoring replaces the board's content for everyone, so only the owner may do it.
  restore: ['owner'],
  // Inviting, changing roles and removing other members is the owner's alone. Leaving the board is
  // handled separately, since any member may leave.
  manage_members: ['owner'],
};

// Non-members get 404, the same as a missing board, so board ids cannot be probed. Members who
// lack the role for the action get 403.
export async function authorizeBoard(
  db: DbExecutor,
  boardId: string,
  userId: string,
  action: BoardAction,
): Promise<BoardRole> {
  const role = await getBoardRole(db, boardId, userId);
  if (!role) {
    throw new AppError(404, 'board_not_found', 'Board not found.');
  }
  if (!allowedRoles[action].includes(role)) {
    throw new AppError(403, 'forbidden', 'Your role on this board does not allow this action.');
  }
  return role;
}
