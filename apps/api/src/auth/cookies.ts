export const SESSION_COOKIE_NAME = 'inkroom_session';
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

// The __Host- prefix makes browsers require Secure, Path=/ and no Domain attribute.
// It is only used when cookies are Secure, because browsers reject it over plain HTTP.
export function sessionCookieName(secure: boolean): string {
  return secure ? `__Host-${SESSION_COOKIE_NAME}` : SESSION_COOKIE_NAME;
}

export function readSessionToken(cookieHeader: string | undefined, secure: boolean) {
  if (!cookieHeader) {
    return undefined;
  }
  const name = sessionCookieName(secure);
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator !== -1 && part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return undefined;
}

export function sessionSetCookie(token: string, secure: boolean): string {
  return serializeCookie(sessionCookieName(secure), token, SESSION_MAX_AGE_SECONDS, secure);
}

export function sessionClearCookie(secure: boolean): string {
  return serializeCookie(sessionCookieName(secure), '', 0, secure);
}

// HttpOnly keeps the token away from page scripts. SameSite=Lax stops cross-site POSTs from
// carrying the cookie; the Origin check in http/origin.ts is the second line of defense.
function serializeCookie(name: string, value: string, maxAgeSeconds: number, secure: boolean) {
  const attributes = [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) {
    attributes.push('Secure');
  }
  return attributes.join('; ');
}
