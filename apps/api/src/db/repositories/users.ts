import { eq } from 'drizzle-orm';
import type { DbExecutor } from '../client';
import { firstRow } from '../rows';
import { users } from '../schema';

export interface NewUser {
  email: string;
  displayName: string;
  passwordHash: string;
}

export async function createUser(db: DbExecutor, input: NewUser) {
  const rows = await db
    .insert(users)
    .values({
      email: input.email.trim().toLowerCase(),
      displayName: input.displayName.trim(),
      passwordHash: input.passwordHash,
    })
    .returning();
  return firstRow(rows, 'users insert');
}

export async function findUserByEmail(db: DbExecutor, email: string) {
  const [row] = await db
    .select()
    .from(users)
    .where(eq(users.email, email.trim().toLowerCase()))
    .limit(1);
  return row ?? null;
}
