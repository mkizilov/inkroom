import type { AuthUser } from '@inkroom/shared';
import type { DbExecutor } from '../db/client';
import {
  createSession,
  findSessionWithUserByTokenHash,
  revokeSessionByTokenHash,
} from '../db/repositories/sessions';
import { createUser, findUserByEmail } from '../db/repositories/users';
import { hashPassword, verifyAgainstPlaceholder, verifyPassword } from './password';
import { generateSessionToken, hashSessionToken } from './session-token';

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type SessionResolution =
  | { status: 'active'; user: AuthUser }
  | { status: 'invalid' | 'expired' | 'revoked' };

export function toAuthUser(user: { id: string; email: string; displayName: string }): AuthUser {
  return { id: user.id, email: user.email, displayName: user.displayName };
}

export async function registerUser(
  db: DbExecutor,
  input: { email: string; password: string; displayName: string },
) {
  const passwordHash = await hashPassword(input.password);
  return createUser(db, {
    email: input.email,
    displayName: input.displayName,
    passwordHash,
  });
}

export async function authenticateUser(db: DbExecutor, email: string, password: string) {
  const user = await findUserByEmail(db, email);
  if (!user) {
    await verifyAgainstPlaceholder(password);
    return null;
  }
  return (await verifyPassword(user.passwordHash, password)) ? user : null;
}

// Returns the raw token for the client's cookie. The database keeps only its hash.
export async function issueSession(db: DbExecutor, userId: string): Promise<string> {
  const token = generateSessionToken();
  await createSession(db, {
    userId,
    tokenHash: hashSessionToken(token),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  return token;
}

export function resolveSession(db: DbExecutor, token: string): Promise<SessionResolution> {
  return resolveSessionHash(db, hashSessionToken(token));
}

// Checks a session by the hash the database stores. Open sockets keep only this hash, so they can be
// re-checked without holding the raw token.
export async function resolveSessionHash(
  db: DbExecutor,
  tokenHash: string,
): Promise<SessionResolution> {
  const row = await findSessionWithUserByTokenHash(db, tokenHash);
  if (!row) {
    return { status: 'invalid' };
  }
  if (row.session.revokedAt) {
    return { status: 'revoked' };
  }
  if (row.session.expiresAt.getTime() <= Date.now()) {
    return { status: 'expired' };
  }
  return { status: 'active', user: toAuthUser(row.user) };
}

export function revokeSession(db: DbExecutor, token: string): Promise<void> {
  return revokeSessionByTokenHash(db, hashSessionToken(token));
}
