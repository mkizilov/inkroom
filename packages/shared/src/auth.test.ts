import { describe, expect, it } from 'vitest';
import { loginRequestSchema, registerRequestSchema } from './auth';

const validRegistration = {
  email: 'Ada@Example.com',
  password: 'correct horse battery',
  displayName: '  Ada  ',
};

describe('registerRequestSchema', () => {
  it('normalizes email and display name', () => {
    expect(registerRequestSchema.parse(validRegistration)).toEqual({
      email: 'ada@example.com',
      password: 'correct horse battery',
      displayName: 'Ada',
    });
  });

  it('rejects passwords shorter than 12 characters with a field message', () => {
    const result = registerRequestSchema.safeParse({ ...validRegistration, password: 'short' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['password']);
    expect(result.error?.issues[0]?.message).toBe('Use at least 12 characters.');
  });

  it('rejects passwords longer than 128 characters', () => {
    const result = registerRequestSchema.safeParse({
      ...validRegistration,
      password: 'x'.repeat(129),
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid email addresses and blank display names', () => {
    expect(
      registerRequestSchema.safeParse({ ...validRegistration, email: 'not-an-email' }).success,
    ).toBe(false);
    expect(
      registerRequestSchema.safeParse({ ...validRegistration, displayName: '   ' }).success,
    ).toBe(false);
  });
});

describe('loginRequestSchema', () => {
  it('accepts any non-empty password up to 128 characters', () => {
    expect(
      loginRequestSchema.safeParse({ email: 'ada@example.com', password: 'a' }).success,
    ).toBe(true);
  });

  it('rejects an empty password', () => {
    expect(loginRequestSchema.safeParse({ email: 'ada@example.com', password: '' }).success).toBe(
      false,
    );
  });
});
