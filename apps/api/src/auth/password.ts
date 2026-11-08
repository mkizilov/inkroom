import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';

// OWASP minimum for Argon2id: 19 MiB of memory, 2 passes, 1 lane.
const HASH_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, HASH_OPTIONS);
}

export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(storedHash, password);
  } catch {
    // A malformed stored hash can never match, so it is treated as a failed verification.
    return false;
  }
}

let placeholderHash: Promise<string> | undefined;

// Runs a full Argon2 verification for unknown emails so response time does not reveal
// whether an account exists.
export async function verifyAgainstPlaceholder(password: string): Promise<void> {
  placeholderHash ??= hashPassword(randomBytes(32).toString('base64url'));
  await verifyPassword(await placeholderHash, password);
}
