import Fastify, { type FastifyInstance } from 'fastify';
import { type HealthResponse } from '@inkroom/shared';
import { createRequireUser } from './auth/middleware';
import { createFailureLimiter } from './auth/rate-limit';
import { registerAuthRoutes } from './auth/routes';
import { registerBoardRoutes } from './boards/routes';
import type { Database } from './db/client';
import { registerErrorHandlers } from './http/errors';
import { requireTrustedOrigin } from './http/origin';

export const DEFAULT_WEB_ORIGIN = 'http://127.0.0.1:21173';

export interface LoginRateLimits {
  maxFailuresPerEmail: number;
  maxFailuresPerIp: number;
  windowMs: number;
}

export const DEFAULT_LOGIN_RATE_LIMITS: LoginRateLimits = {
  maxFailuresPerEmail: 5,
  maxFailuresPerIp: 20,
  windowMs: 15 * 60 * 1000,
};

export interface BuildAppOptions {
  database: Database;
  logger?: boolean;
  webOrigin?: string;
  cookieSecure?: boolean;
  loginRateLimits?: Partial<LoginRateLimits>;
}

export function buildApp({
  database,
  logger = false,
  webOrigin = DEFAULT_WEB_ORIGIN,
  cookieSecure = false,
  loginRateLimits,
}: BuildAppOptions): FastifyInstance {
  const limits = { ...DEFAULT_LOGIN_RATE_LIMITS, ...loginRateLimits };
  const app = Fastify({ logger });

  registerErrorHandlers(app);
  app.addHook('onRequest', requireTrustedOrigin(webOrigin));

  app.get('/api/health', async (request, reply) => {
    let databaseStatus: HealthResponse['database'] = 'up';
    try {
      await database.ping();
    } catch (error) {
      request.log.warn({ err: error }, 'database health check failed');
      databaseStatus = 'down';
    }

    const healthy = databaseStatus === 'up';
    const body: HealthResponse = {
      status: healthy ? 'ok' : 'degraded',
      service: 'inkroom-api',
      database: databaseStatus,
      timestamp: new Date().toISOString(),
    };
    return reply.code(healthy ? 200 : 503).send(body);
  });

  const requireUser = createRequireUser(database.db, cookieSecure);

  registerAuthRoutes(app, {
    db: database.db,
    cookieSecure,
    requireUser,
    limits: {
      byEmail: createFailureLimiter({
        maxFailures: limits.maxFailuresPerEmail,
        windowMs: limits.windowMs,
      }),
      byIp: createFailureLimiter({
        maxFailures: limits.maxFailuresPerIp,
        windowMs: limits.windowMs,
      }),
    },
  });

  registerBoardRoutes(app, { db: database.db, requireUser });

  return app;
}
