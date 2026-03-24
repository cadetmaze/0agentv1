/**
 * Bundle the daemon into a single self-contained file for npm distribution.
 * Native addons (better-sqlite3) are marked external and installed as deps.
 */

import { build } from 'esbuild';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'dist');

mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [resolve(root, 'packages/daemon/src/start.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: resolve(outDir, 'daemon.mjs'),
  external: [
    // Native addons — must be installed separately
    'better-sqlite3',
    // Keep hono as external (large, ESM-only, works fine as dep)
    'hono',
    '@hono/node-server',
    'ws',
    'yaml',
    'zod',
  ],
  // Path aliases for workspace packages
  alias: {
    '@0agent/core':             resolve(root, 'packages/core/src/index.ts'),
    '@0agent/mcp-hub':          resolve(root, 'packages/mcp-hub/src/index.ts'),
    '@0agent/subagent':         resolve(root, 'packages/subagent/src/index.ts'),
    '@0agent/subagent-runtime': resolve(root, 'packages/subagent-runtime/src/index.ts'),
  },
  // TypeScript paths
  tsconfig: resolve(root, 'tsconfig.base.json'),
  logLevel: 'info',
  minify: false,
  sourcemap: false,
  target: 'node20',
});

console.log('✓ Bundled → dist/daemon.mjs');
