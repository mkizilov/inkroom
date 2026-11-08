import type { FastifyRequest } from 'fastify';
import type { AuthUser } from '@inkroom/shared';
import type { DbExecutor } from '../db/client';
import { AppError } from '../http/errors';
import { readSessionToken } from './cookies';
import { SESSION_TOKEN_PATTERN } from './session-token';
import { resolveSession } from './service';

declare module 'fastify' {
  interface FastifyRequest {
    currentUser: AuthUser | null;
  }
}

// Returns the session token from the request cookie, or undefined if it is absent or malformed.
export function requestSessionToken(request: FastifyRequest, cookieSecure: boolean) {
  const token = readSessionToken(request.headers.cookie, cookieSecure);
  return token && SESSION_TOKEN_PATTERN.test(token) ? token : undefined;
}

// Authentication middleware: attaches request.currentUser or rejects with a specific 401 code.
export function createRequireUser(db: DbExecutor, cookieSecure: boolean) {
  return async (request: FastifyRequest): Promise<void> => {
    const token = requestSessionToken(request, cookieSecure);
    if (!token) {
      throw new AppError(401, 'unauthenticated', 'Sign in to continue.');
    }
    const session = await resolveSession(db, token);
    switch (session.status) {
      case 'active':
        request.currentUser = session.user;
        return;
      case 'expired':
        throw new AppError(401, 'session_expired', 'Your session has expired. Sign in again.');
      case 'revoked':
        throw new AppError(401, 'session_revoked', 'You have been signed out. Sign in again.');
      case 'invalid':
        throw new AppError(401, 'unauthenticated', 'Sign in to continue.');
    }
  };
}

// Only valid after createRequireUser has run for the route.
export function currentUserOf(request: FastifyRequest): AuthUser {
  if (!request.currentUser) {
    throw new AppError(401, 'unauthenticated', 'Sign in to continue.');
  }
  return request.currentUser;
}
