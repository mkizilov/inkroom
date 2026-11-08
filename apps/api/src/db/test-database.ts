import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { PoolConfig } from 'pg';
import { Pool } from 'pg';
import { describe } from 'vitest';
import { createDatabase, type Database } from './client';
import { sqlStateOf } from './errors';

// Integration tests need TEST_DATABASE_URL (the Compose database or the CI service). CI sets
// REQUIRE_TEST_DATABASE, so a missing database fails the run instead of skipping the tests silently.
export const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl && process.env.REQUIRE_TEST_DATABASE === 'true') {
  throw new Error('TEST_DATABASE_URL must be set when REQUIRE_TEST_DATABASE is true.');
}
export const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

export interface TestDatabase extends Database {
  schema: string;
  drop(): Promise<void>;
}

// Each test file migrates into its own schema, so files can run in parallel without sharing data.
export async function createTestDatabase(connectionString: string): Promise<TestDatabase> {
  const schema = `inkroom_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString, max: 1 });
  await admin.query(`CREATE SCHEMA "${schema}"`);

  const poolConfig: PoolConfig = { max: 4, options: `-c search_path=${schema}` };
  const database = createDatabase(connectionString, poolConfig);
  await migrate(database.db, {
    migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)),
    migrationsSchema: schema,
  });

  return {
    ...database,
    schema,
    async drop() {
      await database.close();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    },
  };
}

export async function expectSqlState(promise: Promise<unknown>, expected: string): Promise<void> {
  const outcome = await promise.then(
    () => undefined,
    (error: unknown) => ({ error }),
  );
  if (!outcome) {
    throw new Error(`Expected SQLSTATE ${expected}, but the statement succeeded`);
  }
  if (sqlStateOf(outcome.error) !== expected) {
    throw outcome.error;
  }
}
