import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import type { DbExecutor } from './client';

// The migrations live in apps/api/drizzle. From the source tree that is two levels up from this file;
// from the bundled dist/ files it is one level up. Both are tried, so the same code runs in either.
const CANDIDATE_FOLDERS = ['../drizzle', '../../drizzle'];
const JOURNAL = 'meta/_journal.json';

export function resolveMigrationsFolder(): string {
  for (const candidate of CANDIDATE_FOLDERS) {
    const folder = fileURLToPath(new URL(candidate, import.meta.url));
    if (existsSync(`${folder}/${JOURNAL}`)) {
      return folder;
    }
  }
  throw new Error('The database migrations folder was not found next to the application.');
}

// The number of migrations the code ships with, read from Drizzle's journal.
export function expectedMigrationCount(folder: string = resolveMigrationsFolder()): number {
  const journal = JSON.parse(readFileSync(`${folder}/${JOURNAL}`, 'utf8')) as {
    entries: unknown[];
  };
  return journal.entries.length;
}

// The number of migrations recorded as applied in a schema. Throws when Drizzle's table is missing,
// which is the state before the first migration has run.
export async function appliedMigrationCount(db: DbExecutor, schema: string): Promise<number> {
  const result = await db.execute(
    sql`select count(*)::int as count from ${sql.identifier(schema)}.__drizzle_migrations`,
  );
  const row = (result.rows as Array<{ count: number }>)[0];
  return row?.count ?? 0;
}
