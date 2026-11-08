import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

// Load the root .env so TEST_DATABASE_URL reaches the integration tests.
export default defineConfig({
  test: {
    env: loadEnv('test', '../..', ''),
  },
});
