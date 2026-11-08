import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { createDatabase } from './db/client';
import {
  createTestDatabase,
  describeWithDatabase,
  testDatabaseUrl,
  type TestDatabase,
} from './db/test-database';

// No database is needed here: nothing listens on port 1, so the readiness check must fail.
describe('readiness without a database', () => {
  it('reports not ready when the database cannot be reached', async () => {
    const database = createDatabase('postgres://inkroom:inkroom@127.0.0.1:1/inkroom');
    const { app } = await buildApp({ database, startHeartbeat: false });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/ready' });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ status: 'not_ready', reason: 'database_unreachable' });
    } finally {
      await app.close();
      await database.close();
    }
  });
});

describeWithDatabase('readiness with a database', () => {
  let database: TestDatabase;
  let app: FastifyInstance;

  beforeAll(async () => {
    database = await createTestDatabase(testDatabaseUrl ?? '');
    ({ app } = await buildApp({
      database,
      migrationsSchema: database.schema,
      startHeartbeat: false,
    }));
  });

  afterAll(async () => {
    await app.close();
    await database.drop();
  });

  it('reports ready once every migration is applied', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ready' });
  });

  it('reports not ready when the migration table does not exist', async () => {
    const unmigrated = createDatabase(testDatabaseUrl ?? '', { max: 1 });
    const { app: unmigratedApp } = await buildApp({
      database: unmigrated,
      migrationsSchema: `inkroom_missing_${randomUUID().replaceAll('-', '')}`,
      startHeartbeat: false,
    });
    try {
      const response = await unmigratedApp.inject({ method: 'GET', url: '/api/ready' });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ status: 'not_ready', reason: 'migrations_unavailable' });
    } finally {
      await unmigratedApp.close();
      await unmigrated.close();
    }
  });
});
