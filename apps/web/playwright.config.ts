import { defineConfig, devices } from '@playwright/test';

// Loopback ports from the project's 21000-21099 range. The web dev server proxies /api to the API.
const webOrigin = 'http://127.0.0.1:21173';
const apiHealthUrl = 'http://127.0.0.1:21080/api/health';
const reuseServers = !process.env.CI;

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  // A single worker keeps load on the shared database and API low.
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  reporter: [['list']],
  use: {
    baseURL: webOrigin,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      // Runs the API from source with no file watcher and no .env file. Node's watch mode fails on
      // Linux when the .env file it watches is missing. DATABASE_URL comes from the environment, or
      // defaults to the loopback value in .env.example. WEB_ORIGIN and COOKIE_SECURE are fixed, because
      // the browser runs over plain HTTP on that origin.
      command: 'pnpm --filter @inkroom/api serve',
      env: {
        DATABASE_URL:
          process.env.DATABASE_URL ?? 'postgres://inkroom:inkroom@127.0.0.1:21432/inkroom',
        WEB_ORIGIN: webOrigin,
        COOKIE_SECURE: 'false',
      },
      url: apiHealthUrl,
      reuseExistingServer: reuseServers,
      // SIGTERM lets the API close its sync rooms and database pool before the port is released.
      gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
      timeout: 120_000,
    },
    {
      command: 'pnpm --filter @inkroom/web dev',
      url: webOrigin,
      reuseExistingServer: reuseServers,
      timeout: 120_000,
    },
  ],
});
