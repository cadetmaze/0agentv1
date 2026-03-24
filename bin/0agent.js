#!/usr/bin/env node
/**
 * 0agent CLI entry point.
 *
 * This is the Node.js CLI — a thin wrapper that delegates to the daemon
 * REST API for most commands, and handles init/start/stop locally.
 *
 * Usage:
 *   npx 0agent@latest          # first run → triggers init wizard
 *   0agent init                # interactive setup wizard
 *   0agent start               # start daemon in background
 *   0agent stop                # stop daemon
 *   0agent status              # health check
 *   0agent run "<task>"        # submit task
 *   0agent /review             # run a skill (slash command)
 *   0agent chat                # interactive REPL
 *   0agent skill list          # list skills
 *   0agent workflow suggest    # next skill recommendation
 *   0agent improve             # self-improvement analysis
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir, platform } from 'node:os';
import { spawn, execSync } from 'node:child_process';
import { createInterface } from 'node:readline';

const AGENT_DIR   = resolve(homedir(), '.0agent');
const CONFIG_PATH = resolve(AGENT_DIR, 'config.yaml');
const PID_PATH    = resolve(AGENT_DIR, 'daemon.pid');
const LOG_PATH    = resolve(AGENT_DIR, 'logs', 'daemon.log');
const BASE_URL    = process.env['ZEROAGENT_URL'] ?? 'http://localhost:4200';

const args = process.argv.slice(2);
const cmd  = args[0] ?? '';

// ─── Slash command rewrite ────────────────────────────────────────────────
// 0agent /review  →  0agent run --skill review
if (cmd.startsWith('/')) {
  const skillName = cmd.slice(1);
  const skillArgs = args.slice(1);
  runSkill(skillName, skillArgs);
  process.exit(0);
}

// ─── Command dispatch ────────────────────────────────────────────────────
switch (cmd) {
  case '':
  case 'init':
    await runInit();
    break;

  case 'start':
    await startDaemon();
    break;

  case 'stop':
    stopDaemon();
    break;

  case 'status':
    await showStatus();
    break;

  case 'run':
    await runTask(args.slice(1));
    break;

  case 'chat':
    await runChat();
    break;

  case 'skill':
    await runSkillCommand(args.slice(1));
    break;

  case 'workflow':
    await runWorkflowCommand(args.slice(1));
    break;

  case 'improve':
    await runImprove(args.slice(1));
    break;

  case 'logs':
    showLogs(args.slice(1));
    break;

  default:
    showHelp();
    break;
}

// ─── Init wizard ─────────────────────────────────────────────────────────

async function runInit() {
  console.log('\n  ┌─────────────────────────────────────────┐');
  console.log('  │                                         │');
  console.log('  │   0agent — An agent that learns.        │');
  console.log('  │                                         │');
  console.log('  │   v1.0.0 · Apache 2.0                   │');
  console.log('  └─────────────────────────────────────────┘\n');

  // Check if already initialised
  if (existsSync(CONFIG_PATH)) {
    const answer = await ask('Config already exists. Reinitialise? [y/N] ');
    if (answer.toLowerCase() !== 'y') {
      console.log('\n  Run `0agent start` to start the daemon.\n');
      return;
    }
  }

  mkdirSync(resolve(AGENT_DIR, 'logs'), { recursive: true });
  mkdirSync(resolve(AGENT_DIR, 'objects'), { recursive: true });
  mkdirSync(resolve(AGENT_DIR, 'skills', 'builtin'), { recursive: true });
  mkdirSync(resolve(AGENT_DIR, 'skills', 'custom'), { recursive: true });

  console.log('  Step 1 of 4: LLM Provider\n');
  const provider = await choose('  Which LLM provider?', [
    'Anthropic (Claude)  ← recommended',
    'OpenAI (GPT-4o)',
    'Ollama (local, free)',
  ], 0);
  const providerKey = ['anthropic', 'openai', 'ollama'][provider];

  let apiKey = '';
  if (providerKey !== 'ollama') {
    apiKey = await ask(`\n  API Key: `);
    if (!apiKey.trim()) {
      console.log('  ⚠️  No API key provided. You can set it later in ~/.0agent/config.yaml');
    }
  }

  const model = providerKey === 'anthropic' ? 'claude-sonnet-4-6'
    : providerKey === 'openai'    ? 'gpt-4o'
    : 'llama3';

  console.log('\n  Step 2 of 4: Embedding model\n');
  const embedding = await choose('  Embedding backend?', [
    'Local via Ollama (nomic-embed-text)  ← free, private',
    'OpenAI text-embedding-3-small (cloud)',
    'Skip (text-only mode)',
  ], 0);
  const embeddingProvider = ['nomic-ollama', 'openai', 'none'][embedding];

  console.log('\n  Step 3 of 4: Sandbox backend\n');
  const sandboxes = detectSandboxes();
  console.log(`  Detected: ${sandboxes.join(', ') || 'process (fallback)'}`);
  const sandboxChoice = sandboxes[0] ?? 'process';
  console.log(`  Using: ${sandboxChoice}`);

  console.log('\n  Step 4 of 4: Seed graph\n');
  const seed = await choose('  Start with a seed graph?', [
    'software-engineering (skills + sprint workflow)  ← recommended',
    'scratch (empty graph)',
  ], 0);
  const seedName = seed === 0 ? 'software-engineering' : null;

  // Write config
  const dbPath    = resolve(AGENT_DIR, 'graph.db');
  const hnswPath  = resolve(AGENT_DIR, 'hnsw.bin');
  const objPath   = resolve(AGENT_DIR, 'objects');

  const config = `# 0agent configuration
# Edit this file to change settings.
version: "1"

llm_providers:
  - provider: ${providerKey}
    model: ${model}
    api_key: ${apiKey || '""'}
    is_default: true

embedding:
  provider: ${embeddingProvider}
  model: nomic-embed-text
  dimensions: 768

sandbox:
  backend: ${sandboxChoice}

mcp_servers: []

server:
  port: 4200
  host: "127.0.0.1"

graph:
  db_path: "${dbPath}"
  hnsw_path: "${hnswPath}"
  object_store_path: "${objPath}"
${seedName ? `\nseed: "${seedName}"` : ''}
`;

  writeFileSync(CONFIG_PATH, config, 'utf8');
  console.log(`\n  ✓ Config written to ${CONFIG_PATH}`);

  // Copy built-in skills
  const skillsSrc = resolve(dirname(new URL(import.meta.url).pathname), '..', 'skills');
  if (existsSync(skillsSrc)) {
    const { readdirSync, copyFileSync } = await import('node:fs');
    for (const f of readdirSync(skillsSrc).filter(f => f.endsWith('.yaml'))) {
      copyFileSync(resolve(skillsSrc, f), resolve(AGENT_DIR, 'skills', 'builtin', f));
    }
    console.log('  ✓ Built-in skills installed');
  }

  console.log('\n  Starting daemon...\n');
  await startDaemon();
}

function detectSandboxes() {
  const backends = [];
  if (platform() === 'linux') {
    try { existsSync('/dev/kvm') && backends.push('firecracker'); } catch {}
  }
  try { execSync('docker info --format "ok"', { stdio: 'ignore', timeout: 3000 }); backends.push('docker'); } catch {}
  try { execSync('podman info', { stdio: 'ignore', timeout: 3000 }); backends.push('podman'); } catch {}
  try { execSync('bwrap --version', { stdio: 'ignore', timeout: 2000 }); backends.push('bwrap'); } catch {}
  backends.push('process');
  return backends;
}

// ─── Daemon lifecycle ─────────────────────────────────────────────────────

async function startDaemon() {
  if (await isDaemonRunning()) {
    console.log('  Daemon already running on port 4200. Run `0agent status`.');
    return;
  }

  if (!existsSync(CONFIG_PATH)) {
    console.log('  Run `0agent init` first.');
    process.exit(1);
  }

  // Find the daemon start.js — look relative to this file
  const startScript = resolve(
    dirname(new URL(import.meta.url).pathname),
    '..', 'packages', 'daemon', 'dist', 'start.js'
  );

  if (!existsSync(startScript)) {
    console.error(`  Daemon not built. Run: pnpm build\n  Then try again.`);
    process.exit(1);
  }

  mkdirSync(resolve(AGENT_DIR, 'logs'), { recursive: true });

  const logFile = writeFileSync(LOG_PATH, '', 'utf8');
  const child = spawn(process.execPath, [startScript], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env, ZEROAGENT_CONFIG: CONFIG_PATH },
  });
  child.unref();

  // Wait for daemon to be ready (poll /api/health)
  process.stdout.write('  Starting');
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    process.stdout.write('.');
    if (await isDaemonRunning()) {
      console.log(' ✓\n');
      console.log(`  Daemon running on http://localhost:4200`);
      console.log(`  Dashboard: http://localhost:4200`);
      console.log(`  Run: 0agent run "your task"\n`);
      return;
    }
  }
  console.log('\n  Daemon did not start. Check logs: 0agent logs');
}

function stopDaemon() {
  if (!existsSync(PID_PATH)) {
    console.log('  No daemon PID file found. Is it running?');
    return;
  }
  const pid = parseInt(readFileSync(PID_PATH, 'utf8').trim(), 10);
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`  Sent SIGTERM to daemon (pid ${pid}). Shutting down...`);
  } catch (e) {
    console.log(`  Could not stop daemon: ${e instanceof Error ? e.message : e}`);
  }
}

async function showStatus() {
  try {
    const res = await fetch(`${BASE_URL}/api/health`);
    const data = await res.json();
    console.log('\n  0agent daemon status');
    console.log('  ─────────────────────────────');
    console.log(`  Status:        ✓ running`);
    console.log(`  Uptime:        ${Math.round((data.uptime_ms ?? 0) / 1000)}s`);
    console.log(`  Graph:         ${data.graph_nodes ?? 0} nodes, ${data.graph_edges ?? 0} edges`);
    console.log(`  Sessions:      ${data.active_sessions ?? 0} active`);
    console.log(`  Sandbox:       ${data.sandbox_backend ?? 'unknown'}`);
    console.log(`  MCP servers:   ${data.mcp_servers_connected ?? 0} connected`);
    console.log(`  Port:          4200`);
    console.log(`  Dashboard:     http://localhost:4200\n`);
  } catch {
    console.log('\n  0agent daemon is not running. Run: 0agent start\n');
  }
}

// ─── Task execution ───────────────────────────────────────────────────────

async function runTask(taskArgs) {
  let task = '';
  let skill = null;
  let entityId = null;

  for (let i = 0; i < taskArgs.length; i++) {
    if (taskArgs[i] === '--skill' && taskArgs[i + 1]) {
      skill = taskArgs[++i];
    } else if (taskArgs[i] === '--entity' && taskArgs[i + 1]) {
      entityId = taskArgs[++i];
    } else {
      task += (task ? ' ' : '') + taskArgs[i];
    }
  }

  if (!task && !skill) {
    console.log('  Usage: 0agent run "<task>" [--skill <name>] [--entity <id>]');
    return;
  }

  await requireDaemon();

  const body = { task: task || `Run skill: ${skill}`, ...(skill && { skill }), ...(entityId && { entity_id: entityId }) };

  const res = await fetch(`${BASE_URL}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const session = await res.json();
  const sid = session.session_id ?? session.id;
  console.log(`\n  Session: ${sid}`);
  console.log(`  Task:    ${task || skill}`);
  if (entityId) console.log(`  Entity:  ${entityId}`);
  console.log();

  // Stream via WebSocket
  await streamSession(sid);
}

async function runSkill(skillName, extraArgs) {
  const argMap = {};
  for (let i = 0; i < extraArgs.length - 1; i += 2) {
    if (extraArgs[i].startsWith('--')) {
      argMap[extraArgs[i].slice(2)] = extraArgs[i + 1];
    }
  }
  // Build task string with args
  const argStr = Object.entries(argMap).map(([k, v]) => `--${k} ${v}`).join(' ');
  await runTask([`/${skillName}${argStr ? ' ' + argStr : ''}`, '--skill', skillName]);
}

async function streamSession(sessionId) {
  await requireDaemon();

  return new Promise((resolve) => {
    const ws = new (await importWS())(`ws://localhost:4200/ws`);

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'subscribe', topics: ['sessions'] }));
    });

    ws.on('message', (data) => {
      try {
        const event = JSON.parse(data.toString());
        if (event.session_id !== sessionId) return;

        switch (event.type) {
          case 'session.step':
            console.log(`  → ${event.step}`);
            break;
          case 'session.completed':
            console.log('\n  ✓ Completed\n');
            if (event.result?.output) console.log(`  ${event.result.output}\n`);
            ws.close();
            resolve();
            break;
          case 'session.failed':
            console.log(`\n  ✗ Failed: ${event.error}\n`);
            ws.close();
            resolve();
            break;
        }
      } catch {}
    });

    ws.on('error', () => {
      // WS not available — fall back to polling
      ws.close();
      pollSession(sessionId).then(resolve);
    });

    // Timeout
    setTimeout(() => { ws.close(); pollSession(sessionId).then(resolve); }, 300_000);
  });
}

async function pollSession(sessionId) {
  for (let i = 0; i < 300; i++) {
    await sleep(1000);
    const res = await fetch(`${BASE_URL}/api/sessions/${sessionId}`);
    const s = await res.json();
    if (s.status === 'completed') {
      console.log('\n  ✓ Completed\n');
      if (s.result?.output) console.log(`  ${s.result.output}\n`);
      return;
    }
    if (s.status === 'failed') {
      console.log(`\n  ✗ Failed: ${s.error}\n`);
      return;
    }
    process.stdout.write('.');
  }
}

// ─── Chat REPL ───────────────────────────────────────────────────────────

async function runChat() {
  await requireDaemon();
  console.log('\n  0agent chat — type your task, /skill for skills, Ctrl+C to exit\n');
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '  > ' });
  rl.prompt();
  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }
    if (input.startsWith('/')) {
      await runSkill(input.slice(1), []);
    } else {
      await runTask([input]);
    }
    rl.prompt();
  });
  rl.on('close', () => { console.log('\n  Goodbye.\n'); process.exit(0); });
}

// ─── Skill commands ──────────────────────────────────────────────────────

async function runSkillCommand(skillArgs) {
  const sub = skillArgs[0];
  switch (sub) {
    case 'list': {
      await requireDaemon();
      const res = await fetch(`${BASE_URL}/api/skills`);
      const skills = await res.json();
      console.log('\n  Available skills:\n');
      for (const s of (Array.isArray(skills) ? skills : skills.skills ?? [])) {
        console.log(`  /${s.name.padEnd(22)} ${s.category.padEnd(10)} ${s.description}`);
      }
      console.log();
      break;
    }
    case 'show': {
      const name = skillArgs[1];
      if (!name) { console.log('  Usage: 0agent skill show <name>'); break; }
      await requireDaemon();
      const res = await fetch(`${BASE_URL}/api/skills/${name}`);
      if (!res.ok) { console.log(`  Skill not found: ${name}`); break; }
      const s = await res.json();
      console.log(`\n  /${s.name} — ${s.description}`);
      console.log(`  Category:  ${s.category}`);
      console.log(`  Trigger:   ${s.trigger}`);
      if (s.workflow?.follows?.length) console.log(`  Follows:   ${s.workflow.follows.join(', ')}`);
      if (s.workflow?.feeds_into?.length) console.log(`  Feeds into: ${s.workflow.feeds_into.join(', ')}`);
      console.log(`\n  Role prompt preview:\n  ${s.role_prompt?.slice(0, 200)}...\n`);
      break;
    }
    default:
      console.log('  Usage: 0agent skill list | show <name> | create <name> | edit <name>');
  }
}

// ─── Workflow commands ───────────────────────────────────────────────────

async function runWorkflowCommand(wfArgs) {
  const sub = wfArgs[0];
  switch (sub) {
    case 'suggest': {
      await requireDaemon();
      const res = await fetch(`${BASE_URL}/api/workflow/suggest`);
      if (!res.ok) { console.log('  No workflow suggestion available.'); break; }
      const data = await res.json();
      if (data.next_skill) {
        console.log(`\n  Suggested next skill: /${data.next_skill}`);
        console.log(`  Run: 0agent /${data.next_skill}\n`);
      } else {
        console.log('  No next skill suggested (end of workflow or not enough data).');
      }
      break;
    }
    case 'show':
      console.log('\n  Open the dashboard to view the workflow graph:');
      console.log('  http://localhost:4200/workflow\n');
      break;
    default:
      console.log('  Usage: 0agent workflow show | suggest');
  }
}

// ─── Improve ────────────────────────────────────────────────────────────

async function runImprove(improveArgs) {
  const sub = improveArgs[0] ?? 'run';
  await requireDaemon();
  switch (sub) {
    case 'run':
    case '': {
      const res = await fetch(`${BASE_URL}/api/improve`, { method: 'POST' });
      if (!res.ok) { console.log('  Improvement analysis not yet available (Phase 5 backend).'); break; }
      const plan = await res.json();
      console.log('\n  Improvement plan generated:');
      for (const action of plan.priority_actions ?? []) {
        console.log(`  ${action.rank}. ${action.description} [${action.auto_approvable ? 'auto' : 'needs approval'}]`);
      }
      break;
    }
    default:
      console.log('  Usage: 0agent improve [show | apply <n> | history]');
  }
}

// ─── Logs ─────────────────────────────────────────────────────────────────

function showLogs(logArgs) {
  const n = parseInt(logArgs.find(a => a.match(/^\d+$/)) ?? '100', 10);
  if (!existsSync(LOG_PATH)) { console.log('  No logs yet. Run `0agent start` first.'); return; }
  const { execSync } = await import('node:child_process');
  execSync(`tail -${n} "${LOG_PATH}"`, { stdio: 'inherit' });
}

// ─── Help ─────────────────────────────────────────────────────────────────

function showHelp() {
  console.log(`
  0agent — An agent that learns.

  Usage:
    0agent init                    Interactive setup wizard
    0agent start                   Start daemon (background)
    0agent stop                    Stop daemon
    0agent status                  Health + stats
    0agent run "<task>"            Submit a task
    0agent /<skill> [args]         Run a skill (e.g. /review, /build, /qa)
    0agent chat                    Interactive REPL
    0agent skill list              List all skills
    0agent skill show <name>       Show skill details
    0agent workflow suggest        Recommend next skill
    0agent improve                 Self-improvement analysis
    0agent logs                    Tail daemon logs

  Dashboard:
    http://localhost:4200           Web UI (after starting daemon)

  Examples:
    0agent run "fix the auth bug"
    0agent /research "Acme Corp funding"
    0agent /build --task next
    0agent /qa --url https://staging.myapp.com
`);
}

// ─── Helpers ─────────────────────────────────────────────────────────────

async function isDaemonRunning() {
  try {
    const res = await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function requireDaemon() {
  if (!(await isDaemonRunning())) {
    console.log('\n  Daemon is not running. Start it with: 0agent start\n');
    process.exit(1);
  }
}

async function importWS() {
  try {
    const { default: WS } = await import('ws');
    return WS;
  } catch {
    // Fallback to native WebSocket (Node 22+)
    return globalThis.WebSocket;
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function ask(question) {
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => { rl.close(); resolve(answer); });
  });
}

async function choose(question, options, defaultIdx = 0) {
  console.log(`  ${question}\n`);
  options.forEach((o, i) => console.log(`    ${i === defaultIdx ? '●' : '○'} ${o}`));
  const answer = await ask(`\n  Choice [${defaultIdx}]: `);
  const n = parseInt(answer.trim(), 10);
  return isNaN(n) ? defaultIdx : Math.max(0, Math.min(options.length - 1, n));
}
