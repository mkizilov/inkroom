import Fastify, { type FastifyInstance } from 'fastify';
import { type HealthResponse } from '@inkroom/shared';

export interface DatabaseProbe {
  ping(): Promise<void>;
}

export interface BuildAppOptions {
  database: DatabaseProbe;
  logger?: boolean;
}

export function buildApp({ database, logger = false }: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger });

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

  return app;
}
