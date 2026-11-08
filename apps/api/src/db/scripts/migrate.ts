import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { loadConfig } from '../../config';
import { createDatabase } from '../client';

async function main(): Promise<void> {
  const { databaseUrl } = loadConfig();
  const database = createDatabase(databaseUrl);
  try {
    await migrate(database.db, {
      migrationsFolder: fileURLToPath(new URL('../../../drizzle', import.meta.url)),
    });
    console.log('Database migrations are up to date.');
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
