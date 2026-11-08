import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { type HealthResponse } from '@inkroom/shared';
import { createRequireUser } from './auth/middleware';
import { createFailureLimiter } from './auth/rate-limit';
import { registerAuthRoutes } from './auth/routes';
import { registerBoardRoutes } from './boards/routes';
import { registerImportRoutes } from './boards/import';
import { registerMemberRoutes } from './boards/member-routes';
import { registerRevisionRoutes } from './boards/revisions';
import type { Database } from './db/client';
import { appliedMigrationCount, expectedMigrationCount } from './db/migrations';
import { registerErrorHandlers } from './http/errors';
import { requireTrustedOrigin } from './http/origin';
import { PostgresBoardStore } from './persistence/store';
import { DEFAULT_CONNECTION_LIMITS, type ConnectionLimits } from './sync/connections';
import { registerSyncRoutes } from './sync/routes';
import { SyncService } from './sync/service';
import type { RoomLimits } from './sync/room';

export const DEFAULT_WEB_ORIGIN = 'http://127.0.0.1:21173';

// Request headers that carry credentials. They are censored in request logs.
const REDACTED_LOG_PATHS = ['req.headers.cookie', 'req.headers.authorization'];

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
  logLevel?: string;
  // Reverse proxies whose X-Forwarded-For sets the client address. Empty means the socket address is used.
  trustProxy?: string[];
  webOrigin?: string;
  cookieSecure?: boolean;
  // The schema Drizzle records applied migrations in. Readiness checks that they are all applied.
  migrationsSchema?: string;
  loginRateLimits?: Partial<LoginRateLimits>;
  roomLimits?: Partial<RoomLimits>;
  connectionLimits?: Partial<ConnectionLimits>;
  // Compaction thresholds. Tests lower or raise them to control when compaction runs.
  compactEvery?: number;
  sweepThreshold?: number;
  sweepIntervalMs?: number;
  // Interval for re-checking open connections' memberships and sessions. Zero disables it.
  membershipCheckMs?: number;
  // Starts the heartbeat, the compaction sweep and the access check. Tests turn these off and
  // drive them directly.
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
    logLevel = 'info',
    trustProxy = [],
    webOrigin = DEFAULT_WEB_ORIGIN,
    cookieSecure = false,
    migrationsSchema = 'drizzle',
    loginRateLimits,
    roomLimits,
    connectionLimits,
    compactEvery,
    sweepThreshold,
    sweepIntervalMs,
    membershipCheckMs,
    startHeartbeat = true,
  } = options;
  const limits = { ...DEFAULT_LOGIN_RATE_LIMITS, ...loginRateLimits };
  const app = Fastify({
    trustProxy: trustProxy.length > 0 ? trustProxy : false,
    logger: logger
      ? { level: logLevel, redact: { paths: REDACTED_LOG_PATHS, censor: '[redacted]' } }
      : false,
  });
  const expectedMigrations = expectedMigrationCount();

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

  // Readiness is stricter than health: the process can take traffic only when the database answers
  // and every migration the code ships with has been applied. Deployments wait on this.
  app.get('/api/ready', async (request, reply) => {
    try {
      await database.ping();
    } catch (error) {
      request.log.warn({ err: error }, 'readiness: database unreachable');
      return reply.code(503).send({ status: 'not_ready', reason: 'database_unreachable' });
    }
    let applied: number;
    try {
      applied = await appliedMigrationCount(database.db, migrationsSchema);
    } catch (error) {
      request.log.warn({ err: error }, 'readiness: migration table unavailable');
      return reply.code(503).send({ status: 'not_ready', reason: 'migrations_unavailable' });
    }
    if (applied < expectedMigrations) {
      return reply.code(503).send({ status: 'not_ready', reason: 'migrations_pending' });
    }
    return { status: 'ready' };
  });

  const requireUser = createRequireUser(database.db, cookieSecure);
  const store = new PostgresBoardStore(database.db, (boardId, seq, error) => {
    app.log.warn({ err: error, boardId, seq }, 'skipped an unreadable stored update');
  });
  const sync = new SyncService({
    db: database.db,
    store,
    roomLimits,
    connectionLimits: { ...DEFAULT_CONNECTION_LIMITS, ...connectionLimits },
    compactEvery,
    sweepThreshold,
    sweepIntervalMs,
    membershipCheckMs,
    logger: app.log,
  });

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
    onSignOut: (sessionHash) => sync.endSession(sessionHash),
  });

  registerBoardRoutes(app, { db: database.db, requireUser, sync });
  registerImportRoutes(app, { db: database.db, store, requireUser });
  registerMemberRoutes(app, { db: database.db, sync, requireUser });
  registerSyncRoutes(app, { db: database.db, service: sync, webOrigin, cookieSecure });
  registerRevisionRoutes(app, { db: database.db, store, sync, requireUser });

  if (startHeartbeat) {
    sync.startHeartbeat();
    sync.startSweep();
    sync.startMembershipCheck();
  }
  app.addHook('onClose', async () => {
    await sync.shutdown();
  });

  return { app, sync };
}
