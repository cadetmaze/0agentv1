/**
 * Daemon startup entry point.
 * Run directly: node dist/start.js
 * Or via CLI:   0agent start
 */

import { ZeroAgentDaemon } from './ZeroAgentDaemon.js';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';

const CONFIG_PATH = process.env['ZEROAGENT_CONFIG'] ??
  resolve(homedir(), '.0agent', 'config.yaml');

if (!existsSync(CONFIG_PATH)) {
  console.error(`\n  0agent is not initialised.\n\n  Run: npx 0agent@latest init\n`);
  process.exit(1);
}

const daemon = new ZeroAgentDaemon();

try {
  await daemon.start({ config_path: CONFIG_PATH });
} catch (err) {
  console.error('Failed to start daemon:', err instanceof Error ? err.message : err);
  process.exit(1);
}
