import { defineConfig } from 'tsup';

// Two bundles: the server and the migration runner. Workspace packages are inlined, because
// @inkroom/shared is consumed as TypeScript source and Node cannot load that from node_modules.
// npm dependencies stay external and come from the production install.
export default defineConfig({
  entry: { server: 'src/server.ts', migrate: 'src/db/scripts/migrate.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  clean: true,
  noExternal: [/^@inkroom\//],
});
