import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase, type NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { Pool, type PoolConfig } from 'pg';
import * as schema from './schema';

// Accepts both the root database and a transaction, so repositories can run inside either.
export type DbExecutor = PgDatabase<NodePgQueryResultHKT, typeof schema>;

export interface Database {
  db: NodePgDatabase<typeof schema>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export function createDatabase(connectionString: string, poolConfig: PoolConfig = {}): Database {
  const pool = new Pool({ max: 10, ...poolConfig, connectionString });
  const db = drizzle(pool, { schema });

  return {
    db,
    async ping() {
      await db.execute(sql`select 1`);
    },
    close() {
      return pool.end();
    },
  };
}
