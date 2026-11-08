import { afterEach, describe, expect, it } from 'vitest';
import { healthResponseSchema } from '@inkroom/shared';
import { buildApp } from './app';

const healthyDatabase = { ping: async () => {} };
const unavailableDatabase = {
  ping: async () => {
    throw new Error('connection refused');
  },
};

describe('GET /api/health', () => {
  const apps: ReturnType<typeof buildApp>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('reports ok when the database responds', async () => {
    const app = buildApp({ database: healthyDatabase });
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
    const app = buildApp({ database: unavailableDatabase });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(503);
    expect(healthResponseSchema.parse(response.json())).toMatchObject({
      status: 'degraded',
      database: 'down',
    });
  });
});
