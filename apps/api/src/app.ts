import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { type HealthResponse } from '@inkroom/shared';
import { createRequireUser } from './auth/middleware';
import { createFailureLimiter } from './auth/rate-limit';
import { registerAuthRoutes } from './auth/routes';
import { registerBoardRoutes } from './boards/routes';
import type { Database } from './db/client';
import { registerErrorHandlers } from './http/errors';
import { requireTrustedOrigin } from './http/origin';
import {
  DEFAULT_CONNECTION_LIMITS,
  type ConnectionLimits,
} from './sync/connections';
import { SyncService } from './sync/service';
import { registerSyncRoutes } from './sync/routes';
import { DEFAULT_ROOM_LIMITS, type RoomLimits } from './sync/room';

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
  roomLimits?: Partial<RoomLimits>;
  connectionLimits?: Partial<ConnectionLimits>;
  // Heartbeats are a server concern, so tests can run them quickly or not at all.
  startHeartbeat?: boolean;
}

// The sync service is returned with the app so the server can shut it down with the process.
export interface InkRoomApp {
  app: FastifyInstance;
  sync: SyncService;
}

export async function buildApp(options: BuildAppOptions): Promise<InkRoomApp> {
  const {
    database,
    logger = false,
    webOrigin = DEFAULT_WEB_ORIGIN,
    cookieSecure = false,
    loginRateLimits,
    roomLimits,
    connectionLimits,
    startHeartbeat = true,
  } = options;
  const limits = { ...DEFAULT_LOGIN_RATE_LIMITS, ...loginRateLimits };
  const app = Fastify({ logger });

  registerErrorHandlers(app);
  app.addHook('onRequest', requireTrustedOrigin(webOrigin));
  await app.register(fastifyWebsocket);

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

  const connectionLimitsResolved = { ...DEFAULT_CONNECTION_LIMITS, ...connectionLimits };
  const sync = new SyncService({
    db: database.db,
    roomLimits: { ...DEFAULT_ROOM_LIMITS, ...roomLimits },
    connectionLimits: connectionLimitsResolved,
  });
  registerSyncRoutes(app, { db: database.db, service: sync, webOrigin, cookieSecure });
  if (startHeartbeat) {
    sync.startHeartbeat();
  }
  app.addHook('onClose', async () => {
    sync.shutdown();
  });

  return { app, sync };
}
