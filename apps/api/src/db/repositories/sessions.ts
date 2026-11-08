import { and, eq, isNull, sql } from 'drizzle-orm';
import type { DbExecutor } from '../client';
import { firstRow } from '../rows';
import { sessions, users } from '../schema';

export interface NewSession {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
}

// Stores only a hash of the session token; the raw token never reaches the database.
export async function createSession(db: DbExecutor, input: NewSession) {
  const rows = await db.insert(sessions).values(input).returning();
  return firstRow(rows, 'sessions insert');
}

export async function findSessionWithUserByTokenHash(db: DbExecutor, tokenHash: string) {
  const [row] = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.tokenHash, tokenHash))
    .limit(1);
  return row ?? null;
}

export async function revokeSessionByTokenHash(db: DbExecutor, tokenHash: string): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt)));
}
