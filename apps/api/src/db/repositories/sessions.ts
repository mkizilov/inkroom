import { eq } from 'drizzle-orm';
import type { DbExecutor } from '../client';
import { firstRow } from '../rows';
import { sessions } from '../schema';

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

export async function findSessionByTokenHash(db: DbExecutor, tokenHash: string) {
  const [row] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.tokenHash, tokenHash))
    .limit(1);
  return row ?? null;
}
