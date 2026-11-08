import { describe, expect, it } from 'vitest';
import {
  readSessionToken,
  sessionClearCookie,
  sessionCookieName,
  sessionSetCookie,
} from './cookies';

describe('session cookies', () => {
  const token = 'a'.repeat(43);

  it('sets HttpOnly and SameSite=Lax with a seven day lifetime', () => {
    const header = sessionSetCookie(token, false);
    expect(header).toBe(`inkroom_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`);
  });

  it('adds Secure and the __Host- prefix when cookies are secure', () => {
    const header = sessionSetCookie(token, true);
    expect(sessionCookieName(true)).toBe('__Host-inkroom_session');
    expect(header).toMatch(/^__Host-inkroom_session=.*; Secure$/);
  });

  it('clears the cookie with Max-Age=0', () => {
    expect(sessionClearCookie(false)).toBe(
      'inkroom_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
    );
  });

  it('reads the session token from a cookie header among other cookies', () => {
    expect(readSessionToken(`theme=dark; inkroom_session=${token}; lang=en`, false)).toBe(token);
  });

  it('ignores the token when the cookie name does not match the security mode', () => {
    expect(readSessionToken(`inkroom_session=${token}`, true)).toBeUndefined();
    expect(readSessionToken(`__Host-inkroom_session=${token}`, false)).toBeUndefined();
  });

  it('returns undefined when no cookie header is present', () => {
    expect(readSessionToken(undefined, false)).toBeUndefined();
  });
});
