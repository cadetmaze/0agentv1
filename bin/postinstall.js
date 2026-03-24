#!/usr/bin/env node
/**
 * postinstall — runs automatically after `npm install -g 0agent`
 *
 * Ensures all runtime dependencies are installed in the package directory.
 * This handles cases where native modules (better-sqlite3) failed to build,
 * or where the package was installed in a non-standard way.
 */

import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Runtime deps that must be present (matches bundle externals in scripts/bundle.mjs)
const REQUIRED = [
  'better-sqlite3',
  'hono',
  '@hono/node-server',
  'ws',
  'yaml',
  'zod',
];

function depInstalled(name) {
  // Handle scoped packages like @hono/node-server
  const modPath = resolve(pkgRoot, 'node_modules', name);
  return existsSync(modPath);
}

const missing = REQUIRED.filter(d => !depInstalled(d));

if (missing.length === 0) {
  // All present — check if better-sqlite3 native binary actually loads
  try {
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    req('better-sqlite3');
  } catch {
    // Binary broken — try rebuild
    try {
      process.stdout.write('  Rebuilding better-sqlite3 for this platform…\n');
      execSync('npm rebuild better-sqlite3', {
        cwd: pkgRoot,
        stdio: 'inherit',
        timeout: 60_000,
      });
    } catch {
      process.stdout.write(
        '  ⚠  Could not rebuild better-sqlite3. Memory persistence will be disabled.\n' +
        '     If you need it, install build tools:\n' +
        '       macOS: xcode-select --install\n' +
        '       Linux: sudo apt-get install build-essential python3\n'
      );
    }
  }
  process.exit(0);
}

process.stdout.write(`  Installing dependencies: ${missing.join(', ')}\n`);

try {
  execSync(
    `npm install --omit=dev --prefix "${pkgRoot}" ${missing.join(' ')}`,
    { stdio: 'inherit', timeout: 120_000 }
  );
  process.stdout.write('  ✓ Dependencies installed\n');
} catch (err) {
  process.stderr.write(
    `  ✗ Failed to install some dependencies: ${err.message}\n` +
    `  Try manually: npm install --prefix "${pkgRoot}" ${missing.join(' ')}\n`
  );
  // Don't exit non-zero — let the agent start anyway; daemon will log the actual error
}
