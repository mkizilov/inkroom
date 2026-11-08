import react from '@vitejs/plugin-react';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 21173,
    strictPort: true,
    proxy: {
      // ws: true forwards the WebSocket upgrade for board sync.
      '/api': { target: 'http://127.0.0.1:21080', ws: true },
    },
  },
  test: {
    environment: 'jsdom',
    // Browser specs run under Playwright (pnpm test:e2e), not under Vitest.
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
});
