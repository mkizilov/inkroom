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
      command: 'pnpm --filter @inkroom/api dev',
      url: apiHealthUrl,
      reuseExistingServer: reuseServers,
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
