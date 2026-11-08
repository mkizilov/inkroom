import type { FastifyInstance, FastifyRequest } from 'fastify';
import { loginRequestSchema, registerRequestSchema } from '@inkroom/shared';
import type { DbExecutor } from '../db/client';
import { sqlStateOf, UNIQUE_VIOLATION } from '../db/errors';
import { AppError } from '../http/errors';
import { parseBody } from '../http/validation';
import { sessionClearCookie, sessionSetCookie } from './cookies';
import { currentUserOf, requestSessionToken } from './middleware';
import { type FailureLimiter } from './rate-limit';
import {
  authenticateUser,
  issueSession,
  registerUser,
  revokeSession,
  toAuthUser,
} from './service';

export interface AuthRouteOptions {
  db: DbExecutor;
  cookieSecure: boolean;
  requireUser: (request: FastifyRequest) => Promise<void>;
  limits: { byEmail: FailureLimiter; byIp: FailureLimiter };
}

export function registerAuthRoutes(app: FastifyInstance, options: AuthRouteOptions): void {
  const { db, cookieSecure, requireUser, limits } = options;
  app.decorateRequest('currentUser', null);

  const setSessionCookie = (token: string) => sessionSetCookie(token, cookieSecure);

  app.post('/api/auth/register', async (request, reply) => {
    const input = parseBody(registerRequestSchema, request.body);
    const user = await registerUser(db, input).catch((error: unknown) => {
      if (sqlStateOf(error) === UNIQUE_VIOLATION) {
        throw new AppError(409, 'email_taken', 'An account with this email already exists.');
      }
      throw error;
    });
    const token = await issueSession(db, user.id);
    reply.header('Set-Cookie', setSessionCookie(token));
    return reply.code(201).send({ user: toAuthUser(user) });
  });

  app.post('/api/auth/login', async (request, reply) => {
    const { email, password } = parseBody(loginRequestSchema, request.body);
    const retryAfter = Math.max(
      limits.byEmail.retryAfterSeconds(email),
      limits.byIp.retryAfterSeconds(request.ip),
    );
    if (retryAfter > 0) {
      throw new AppError(
        429,
        'rate_limited',
        'Too many sign-in attempts. Wait a few minutes and try again.',
        undefined,
        { 'Retry-After': String(retryAfter) },
      );
    }

    const user = await authenticateUser(db, email, password);
    if (!user) {
      limits.byEmail.recordFailure(email);
      limits.byIp.recordFailure(request.ip);
      throw new AppError(401, 'invalid_credentials', 'Email or password is incorrect.');
    }

    limits.byEmail.reset(email);
    const token = await issueSession(db, user.id);
    reply.header('Set-Cookie', setSessionCookie(token));
    return { user: toAuthUser(user) };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const token = requestSessionToken(request, cookieSecure);
    if (token) {
      await revokeSession(db, token);
    }
    reply.header('Set-Cookie', sessionClearCookie(cookieSecure));
    return reply.code(204).send();
  });

  app.get('/api/auth/me', { preHandler: requireUser }, async (request) => ({
    user: currentUserOf(request),
  }));
}
