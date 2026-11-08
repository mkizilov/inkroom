import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { sessions } from '../db/schema';
import { createUser, findUserByEmail } from '../db/repositories/users';
import {
  createTestDatabase,
  describeWithDatabase,
  testDatabaseUrl,
  type TestDatabase,
} from '../db/test-database';
import { generateSessionToken, hashSessionToken } from './session-token';

const WEB_ORIGIN = 'http://127.0.0.1:21173';
const PASSWORD = 'correct horse battery';

const uniqueEmail = () => `${randomUUID()}@example.com`;

// Extracts "name=value" for the session cookie from a response, or undefined if none is set.
function sessionCookieFrom(setCookie: string | string[] | undefined): string | undefined {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const cookie = values.find((value) => /^(__Host-)?inkroom_session=[^;]+/.test(value));
  return cookie?.split(';')[0];
}

describeWithDatabase('authentication', () => {
  let database: TestDatabase;
  let app: FastifyInstance;

  beforeAll(async () => {
    database = await createTestDatabase(testDatabaseUrl ?? '');
    app = buildApp({
      database,
      webOrigin: WEB_ORIGIN,
      cookieSecure: false,
      loginRateLimits: { maxFailuresPerEmail: 3, maxFailuresPerIp: 100, windowMs: 60_000 },
    });
  });

  afterAll(async () => {
    await app.close();
    await database.drop();
  });

  const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url,
      payload: payload as Record<string, unknown>,
      headers: { origin: WEB_ORIGIN, ...headers },
    });

  const register = (email = uniqueEmail(), password = PASSWORD) =>
    post('/api/auth/register', { email, password, displayName: 'Test person' });

  it('registers a user with an Argon2id hash and an HttpOnly session cookie', async () => {
    const email = uniqueEmail();
    const response = await register(email);

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ user: { email, displayName: 'Test person' } });

    const setCookie = response.headers['set-cookie'];
    expect(String(setCookie)).toContain('HttpOnly');
    expect(String(setCookie)).toContain('SameSite=Lax');
    expect(String(setCookie)).not.toContain('Secure');

    const stored = await findUserByEmail(database.db, email);
    expect(stored?.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(stored?.passwordHash).not.toContain(PASSWORD);
  });

  it('returns the current user for a valid session cookie', async () => {
    const email = uniqueEmail();
    const cookie = sessionCookieFrom((await register(email)).headers['set-cookie']);

    const response = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ user: { email } });
  });

  it('logs in with correct credentials and issues a new session', async () => {
    const email = uniqueEmail();
    await register(email);

    const response = await post('/api/auth/login', { email, password: PASSWORD });
    const cookie = sessionCookieFrom(response.headers['set-cookie']);

    expect(response.statusCode).toBe(200);
    expect(cookie).toBeDefined();
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
  });

  it('rejects a wrong password and an unknown email with the same response', async () => {
    const email = uniqueEmail();
    await register(email);

    const wrongPassword = await post('/api/auth/login', {
      email,
      password: 'wrong horse battery',
    });
    const unknownEmail = await post('/api/auth/login', {
      email: uniqueEmail(),
      password: PASSWORD,
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(wrongPassword.json()).toEqual(unknownEmail.json());
    expect(wrongPassword.json()).toMatchObject({ error: { code: 'invalid_credentials' } });
    expect(wrongPassword.headers['set-cookie']).toBeUndefined();
  });

  it('blocks an email after repeated failures, even with the right password', async () => {
    const email = uniqueEmail();
    await register(email);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await post('/api/auth/login', { email, password: 'wrong horse battery' });
    }
    const blocked = await post('/api/auth/login', { email, password: PASSWORD });

    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ error: { code: 'rate_limited' } });
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('rejects unauthenticated access and malformed session cookies', async () => {
    const missing = await app.inject({ method: 'GET', url: '/api/auth/me' });
    const malformed = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: 'inkroom_session=not-a-real-token' },
    });
    const unknown = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: `inkroom_session=${generateSessionToken()}` },
    });

    for (const response of [missing, malformed, unknown]) {
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: 'unauthenticated' } });
    }
  });

  it('rejects an expired session', async () => {
    const user = await createUser(database.db, {
      email: uniqueEmail(),
      displayName: 'Expired',
      passwordHash: 'test-hash',
    });

    const token = generateSessionToken();
    const now = Date.now();
    await database.db.insert(sessions).values({
      userId: user.id,
      tokenHash: hashSessionToken(token),
      createdAt: new Date(now - 2 * 60 * 60 * 1000),
      expiresAt: new Date(now - 60 * 60 * 1000),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: `inkroom_session=${token}` },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'session_expired' } });
  });

  it('revokes the session on logout and clears the cookie', async () => {
    const email = uniqueEmail();
    const cookie = sessionCookieFrom((await register(email)).headers['set-cookie']);

    const logout = await post('/api/auth/logout', undefined, { cookie: cookie ?? '' });
    const after = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });

    expect(logout.statusCode).toBe(204);
    expect(String(logout.headers['set-cookie'])).toContain('Max-Age=0');
    expect(after.statusCode).toBe(401);
    expect(after.json()).toMatchObject({ error: { code: 'session_revoked' } });
  });

  it('rejects state-changing requests from a foreign or missing origin', async () => {
    const email = uniqueEmail();
    const cookie = sessionCookieFrom((await register(email)).headers['set-cookie']);

    const foreign = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { origin: 'https://evil.example', cookie },
    });
    const missing = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie },
    });
    const stillSignedIn = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie },
    });

    expect(foreign.statusCode).toBe(403);
    expect(foreign.json()).toMatchObject({ error: { code: 'csrf_origin_rejected' } });
    expect(missing.statusCode).toBe(403);
    expect(stillSignedIn.statusCode).toBe(200);
  });

  it('validates registration input with field-level errors', async () => {
    const response = await register(uniqueEmail(), 'short');

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: 'validation_failed',
        details: [{ field: 'password', message: 'Use at least 12 characters.' }],
      },
    });
  });

  it('rejects registering an email that already exists', async () => {
    const email = uniqueEmail();
    await register(email);

    const response = await register(email);

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'email_taken' } });
  });

  it('returns a JSON error for unknown routes', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/nope' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'not_found' } });
  });
});
