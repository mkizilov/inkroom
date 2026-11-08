import { buildApp } from './app';
import { loadConfig } from './config';
import { createDatabase } from './db/client';

async function main(): Promise<void> {
  const config = loadConfig();
  const database = createDatabase(config.databaseUrl);
  const { app, sync } = await buildApp({
    database,
    logger: true,
    webOrigin: config.webOrigin,
    cookieSecure: config.cookieSecure,
  });

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await sync.shutdown();
    await app.close();
    await database.close();
    process.exit(0);
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void shutdown(signal);
    });
  }

  await app.listen({ host: config.host, port: config.port });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
