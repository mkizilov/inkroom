import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { loadConfig } from '../../config';
import { createDatabase } from '../client';
import { resolveMigrationsFolder } from '../migrations';

// Applies pending migrations and exits. Run once per deployment, before the API starts. Each
// migration runs in its own transaction, so a failed migration leaves the schema as it was.
async function main(): Promise<void> {
  const { databaseUrl } = loadConfig();
  const database = createDatabase(databaseUrl, { max: 1 });
  try {
    await migrate(database.db, { migrationsFolder: resolveMigrationsFolder() });
    console.log('Database migrations are up to date.');
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
