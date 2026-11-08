import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import * as schema from './schema';

export interface Database {
  ping(): Promise<void>;
  close(): Promise<void>;
}

export function createDatabase(connectionString: string): Database {
  const pool = new Pool({ connectionString, max: 10 });
  const db = drizzle(pool, { schema });

  return {
    async ping() {
      await db.execute(sql`select 1`);
    },
    close() {
      return pool.end();
    },
  };
}
