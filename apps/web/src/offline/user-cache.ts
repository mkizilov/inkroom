import { authUserSchema, type AuthUser } from '@inkroom/shared';

// The user who last signed in on this device. The app uses it to open saved boards when the server
// cannot be reached. It holds no secret: the session stays in an HTTP-only cookie. It is removed on
// sign-out, and when the server says the session is no longer valid.

const KEY = 'inkroom.lastUser';

export function rememberUser(user: AuthUser): void {
  localStorage.setItem(KEY, JSON.stringify(user));
}

export function recalledUser(): AuthUser | null {
  const raw = localStorage.getItem(KEY);
  if (raw === null) {
    return null;
  }
  try {
    const parsed = authUserSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    // A corrupted entry is not a signed-in user. Offline access stays off until the next sign-in.
    return null;
  }
}

export function forgetUser(): void {
  localStorage.removeItem(KEY);
}
