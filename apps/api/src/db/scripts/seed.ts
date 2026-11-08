import { loadConfig } from '../../config';
import { createDatabase } from '../client';
import { seedDevelopmentData } from '../seed';

async function main(): Promise<void> {
  const { databaseUrl } = loadConfig();
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed development data when NODE_ENV=production');
  }

  const database = createDatabase(databaseUrl);
  try {
    const result = await seedDevelopmentData(database.db);
    console.log(
      result === 'seeded'
        ? 'Seeded development data: alice@example.com, bob@example.com, carol@example.com.'
        : 'Development data already present; nothing to do.',
    );
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
