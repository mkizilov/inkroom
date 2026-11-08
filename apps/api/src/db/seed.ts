import { hashPassword } from '../auth/password';
import { createUser, findUserByEmail } from './repositories/users';
import { createBoard } from './repositories/boards';
import { addMember } from './repositories/memberships';
import { appendDocumentUpdate } from './repositories/document';
import type { DbExecutor } from './client';

export const demoUsers = {
  owner: { email: 'alice@example.com', displayName: 'Alice (owner)' },
  editor: { email: 'bob@example.com', displayName: 'Bob (editor)' },
  viewer: { email: 'carol@example.com', displayName: 'Carol (viewer)' },
} as const;

export const demoBoardTitle = 'Seed board';

// Development-only credentials shared by all demo users. Seeding refuses to run in production.
export const demoPassword = 'demo-password-123';

// Seeding is skipped once the demo owner exists, so running it twice is safe.
export async function seedDevelopmentData(db: DbExecutor): Promise<'seeded' | 'already-seeded'> {
  if (await findUserByEmail(db, demoUsers.owner.email)) {
    return 'already-seeded';
  }

  const passwordHash = await hashPassword(demoPassword);
  await db.transaction(async (tx) => {
    const owner = await createUser(tx, { ...demoUsers.owner, passwordHash });
    const editor = await createUser(tx, { ...demoUsers.editor, passwordHash });
    const viewer = await createUser(tx, { ...demoUsers.viewer, passwordHash });

    const board = await createBoard(tx, { ownerId: owner.id, title: demoBoardTitle });
    await addMember(tx, { boardId: board.id, userId: editor.id, role: 'editor' });
    await addMember(tx, { boardId: board.id, userId: viewer.id, role: 'viewer' });

    // Two zero bytes is the Yjs encoding of an empty update: no structs and no delete set.
    await appendDocumentUpdate(tx, {
      boardId: board.id,
      authorId: owner.id,
      payload: Buffer.from([0, 0]),
    });
  });

  return 'seeded';
}
