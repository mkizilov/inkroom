import { afterEach, describe, expect, it } from 'vitest';
import { healthResponseSchema } from '@inkroom/shared';
import { buildApp } from './app';
import type { Database } from './db/client';

// Health tests never touch the database, so the query interface is left unset.
const stubDatabase = (ping: () => Promise<void>): Database => ({
  db: undefined as unknown as Database['db'],
  ping,
  close: async () => {},
});

const healthyDatabase = stubDatabase(async () => {});
const unavailableDatabase = stubDatabase(async () => {
  throw new Error('connection refused');
});

describe('GET /api/health', () => {
  const apps: Array<Awaited<ReturnType<typeof buildApp>>['app']> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('reports ok when the database responds', async () => {
    const { app } = await buildApp({ database: healthyDatabase, startHeartbeat: false });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(200);
    expect(healthResponseSchema.parse(response.json())).toMatchObject({
      status: 'ok',
      service: 'inkroom-api',
      database: 'up',
    });
  });

  it('reports degraded with 503 when the database is unavailable', async () => {
    const { app } = await buildApp({ database: unavailableDatabase, startHeartbeat: false });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(503);
    expect(healthResponseSchema.parse(response.json())).toMatchObject({
      status: 'degraded',
      database: 'down',
    });
  });
});
