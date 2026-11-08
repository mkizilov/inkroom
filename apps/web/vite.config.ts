import react from '@vitejs/plugin-react';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 21173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:21080',
    },
  },
  test: {
    environment: 'jsdom',
    // Browser specs run under Playwright (pnpm test:e2e), not under Vitest.
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
});
