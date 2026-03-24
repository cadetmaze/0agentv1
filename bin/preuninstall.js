#!/usr/bin/env node
/**
 * preuninstall — runs automatically before `npm uninstall -g 0agent`
 *
 * Kills the daemon and ALL processes spawned by 0agent so nothing
 * keeps running (e.g. opening Brave) after the package is removed.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

const AGENT_DIR = resolve(homedir(), '.0agent');
const PID_PATH  = resolve(AGENT_DIR, 'daemon.pid');

function run(cmd) {
  try { execSync(cmd, { stdio: 'ignore', timeout: 5000 }); } catch {}
}

process.stdout.write('  Stopping 0agent daemon and background processes…\n');

// 1. Kill daemon by PID file
if (existsSync(PID_PATH)) {
  try {
    const pid = parseInt(readFileSync(PID_PATH, 'utf8').trim(), 10);
    if (!isNaN(pid)) process.kill(pid, 'SIGTERM');
  } catch {}
  try { unlinkSync(PID_PATH); } catch {}
}

// 2. Kill by process name (catches daemons started by chat.js or other means)
run('pkill -f "daemon.mjs" 2>/dev/null; true');

// 3. Kill any GUI Python scripts still running
run('pkill -f "0agent_gui_" 2>/dev/null; true');
run('pkill -f "0agent-bg-" 2>/dev/null; true');

// 4. Free port 4200 (last resort)
run('lsof -ti:4200 | xargs kill -9 2>/dev/null; true');

// 5. Remove any launchd plists that 0agent may have registered
// (prevents apps from being re-launched on login)
const launchAgentsDir = resolve(homedir(), 'Library', 'LaunchAgents');
if (existsSync(launchAgentsDir)) {
  try {
    const { readdirSync } = await import('node:fs');
    for (const f of readdirSync(launchAgentsDir)) {
      if (f.includes('0agent') || f.includes('zeroagent')) {
        const plistPath = resolve(launchAgentsDir, f);
        run(`launchctl unload "${plistPath}" 2>/dev/null; true`);
        try { unlinkSync(plistPath); } catch {}
        process.stdout.write(`  Removed launchd plist: ${f}\n`);
      }
    }
  } catch {}
}

// 6. Remove 0agent crontab entries (if any were ever added)
run('crontab -l 2>/dev/null | grep -v "0agent" | crontab - 2>/dev/null; true');

process.stdout.write('  ✓ 0agent stopped and cleaned up\n');
