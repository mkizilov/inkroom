// Lets Node import the web app's modules without a bundler. Extensionless relative imports resolve to
// their .ts files (or index.ts). Type-only imports are erased by Node's type stripping, so the pure
// canvas modules run with no installed dependencies.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function resolve(specifier, context, nextResolve) {
  const relative = specifier.startsWith('./') || specifier.startsWith('../');
  if (relative && !/\.[cm]?[jt]sx?$/.test(specifier) && context.parentURL) {
    const base = fileURLToPath(new URL(specifier, context.parentURL));
    if (existsSync(`${base}.ts`)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    if (existsSync(`${base}/index.ts`)) {
      return nextResolve(`${specifier}/index.ts`, context);
    }
  }
  return nextResolve(specifier, context);
}
