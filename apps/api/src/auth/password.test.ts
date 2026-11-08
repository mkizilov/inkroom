import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password';

describe('password hashing', () => {
  it('stores an Argon2id hash that is not the plaintext', async () => {
    const hash = await hashPassword('correct horse battery');

    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(hash).not.toContain('correct horse battery');
  });

  it('verifies the matching password only', async () => {
    const hash = await hashPassword('correct horse battery');

    expect(await verifyPassword(hash, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(hash, 'wrong horse battery')).toBe(false);
  });

  it('treats a malformed stored hash as a failed verification', async () => {
    expect(await verifyPassword('not-a-hash', 'anything')).toBe(false);
  });
});
