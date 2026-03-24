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

  case 'team':
    await runTeamCommand(args.slice(1));
    break;

  case 'serve':
    await runServe(args.slice(1));
    break;

  case 'watch':
    await runWatch();
    break;

  case 'memory':
    await runMemoryCommand(args.slice(1));
    break;

  default:
    showHelp();
    break;
}

// ─── Init wizard — arrow key selection, GitHub memory built in ───────────────

// Arrow-key select using enquirer (falls back to number input if not available)
async function arrowSelect(message, choices, initial = 0) {
  try {
    const { Select } = await import('enquirer');
    const prompt = new Select({ message, choices: choices.map((c, i) => ({ name: c, value: i })), initial });
    const answer = await prompt.run();
    return choices.indexOf(answer);
  } catch {
    // Fallback: number-based selection (no enquirer)
    return choose(message, choices, initial);
  }
}

async function arrowInput(message, initial = '') {
  try {
    const { Input } = await import('enquirer');
    const prompt = new Input({ message, initial });
    return await prompt.run();
  } catch {
    return ask(`  ${message}: `);
  }
}

async function arrowPassword(message) {
  try {
    const { Password } = await import('enquirer');
    const prompt = new Password({ message });
    return await prompt.run();
  } catch {
    return ask(`  ${message}: `);
  }
}

async function runInit() {
  console.log('\n  \x1b[1m┌─────────────────────────────────────────┐\x1b[0m');
  console.log('  \x1b[1m│                                         │\x1b[0m');
  console.log('  \x1b[1m│   0agent — An agent that learns.        │\x1b[0m');
  console.log('  \x1b[1m│                                         │\x1b[0m');
  console.log('  \x1b[1m│   v1.0 · Apache 2.0                     │\x1b[0m');
  console.log('  \x1b[1m└─────────────────────────────────────────┘\x1b[0m\n');

  if (existsSync(CONFIG_PATH)) {
    const answer = await ask('  Config already exists. Reinitialise? [y/N] ');
    if (answer.toLowerCase() !== 'y') {
      console.log('\n  Running: 0agent start\n');
      await startDaemon();
      return;
    }
  }

  mkdirSync(resolve(AGENT_DIR, 'logs'), { recursive: true });
  mkdirSync(resolve(AGENT_DIR, 'objects'), { recursive: true });
  mkdirSync(resolve(AGENT_DIR, 'skills', 'builtin'), { recursive: true });
  mkdirSync(resolve(AGENT_DIR, 'skills', 'custom'), { recursive: true });

  // ── Step 1: LLM Provider ────────────────────────────────────────────────
  const providerIdx = await arrowSelect('LLM Provider', [
    'Anthropic (Claude)  ← recommended',
    'OpenAI (GPT-4o)',
    'xAI (Grok)',
    'Google (Gemini)',
    'Ollama (local — no API key)',
  ], 0);
  const providerKey = ['anthropic', 'openai', 'xai', 'gemini', 'ollama'][providerIdx];

  const MODELS = {
    anthropic: ['claude-sonnet-4-6  ← recommended', 'claude-opus-4-6  (most capable)', 'claude-haiku-4-5  (fastest)'],
    openai:    ['gpt-4o  ← recommended', 'gpt-4o-mini', 'o3-mini'],
    xai:       ['grok-3  ← recommended', 'grok-3-mini'],
    gemini:    ['gemini-2.0-flash  ← recommended', 'gemini-2.0-pro'],
    ollama:    ['llama3.1  ← recommended', 'mistral', 'codellama'],
  };
  const modelIdx = await arrowSelect('Which model?', MODELS[providerKey], 0);
  const model = MODELS[providerKey][modelIdx].split(/\s+/)[0];

  let apiKey = '';
  if (providerKey !== 'ollama') {
    apiKey = await arrowPassword(`${providerKey} API key`);
    apiKey = apiKey.trim();
    if (!apiKey) {
      console.log('  \x1b[33m⚠\x1b[0m  No key — add it later in ~/.0agent/config.yaml');
    } else {
      const pfx = { anthropic: 'sk-ant-', openai: 'sk-', xai: 'xai-', gemini: 'AI' }[providerKey];
      if (pfx && !apiKey.startsWith(pfx)) {
        console.log(`  \x1b[33m⚠\x1b[0m  Unexpected key format (expected ${pfx}...)`);
      } else {
        console.log('  \x1b[32m✓\x1b[0m  Key format valid');
      }
    }
  }

  // ── Step 2: GitHub Memory ───────────────────────────────────────────────
  const memChoice = await arrowSelect('Back up memory to GitHub?', [
    'Yes — private repo, free, cross-device sync  ← recommended',
    'No — local only',
  ], 0);

  let ghToken = '', ghOwner = '', ghRepo = '0agent-memory';
  if (memChoice === 0) {
    // Try gh CLI first
    try {
      const { execSync: ex } = await import('node:child_process');
      ghToken = ex('gh auth token 2>/dev/null', { encoding: 'utf8' }).trim();
      ghOwner = ex('gh api user --jq .login 2>/dev/null', { encoding: 'utf8' }).trim();
      if (ghToken && ghOwner) {
        console.log(`  \x1b[32m✓\x1b[0m  gh CLI — authenticated as \x1b[1m${ghOwner}\x1b[0m`);
      }
    } catch {}

    if (!ghToken) {
      console.log('\n  Create a GitHub token: \x1b[4mhttps://github.com/settings/tokens/new\x1b[0m');
      console.log('  Required scope: \x1b[1mrepo\x1b[0m\n');
      ghToken = await arrowPassword('GitHub token (ghp_...)');
      ghToken = ghToken.trim();
      if (ghToken) {
        ghOwner = await verifyGitHubToken(ghToken) ?? '';
        if (!ghOwner) {
          console.log('  \x1b[31m✗\x1b[0m  Invalid token — skipping GitHub memory');
          ghToken = '';
        } else {
          console.log(`  \x1b[32m✓\x1b[0m  Authenticated as \x1b[1m${ghOwner}\x1b[0m`);
        }
      }
    }

    if (ghToken && ghOwner) {
      process.stdout.write(`  Creating private repo \x1b[1m${ghOwner}/0agent-memory\x1b[0m...`);
      const ok = await createGitHubRepo(ghToken, '0agent-memory');
      console.log(ok ? ' \x1b[32m✓\x1b[0m' : ' \x1b[33m(exists)\x1b[0m');
    }
  }

  // ── Step 3: Embedding ────────────────────────────────────────────────────
  const embIdx = await arrowSelect('Embeddings (for semantic memory search)?', [
    'Local via Ollama (nomic-embed-text) — free, private',
    'OpenAI text-embedding-3-small — cloud',
    'Skip — text-only mode',
  ], 0);
  const embeddingProvider = ['nomic-ollama', 'openai', 'none'][embIdx];

  // ── Step 4: Sandbox ──────────────────────────────────────────────────────
  const sandboxes = detectSandboxes();
  const sandboxChoice = sandboxes[0] ?? 'process';
  console.log(`\n  Sandbox: \x1b[32m${sandboxChoice}\x1b[0m detected`);

  // ── Step 5: Seed graph ───────────────────────────────────────────────────
  const seedIdx = await arrowSelect('Starting knowledge?', [
    'software-engineering — sprint workflow + 15 skills  ← recommended',
    'Start from scratch',
  ], 0);
  const seedName = seedIdx === 0 ? 'software-engineering' : null;

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n  \x1b[1mReady to launch\x1b[0m\n');
  console.log(`  LLM:     \x1b[36m${providerKey}/${model}\x1b[0m`);
  console.log(`  API Key: ${apiKey ? '\x1b[32m✓ set\x1b[0m (' + apiKey.slice(0, 8) + '••••)' : '\x1b[33mnot set\x1b[0m'}`);
  console.log(`  Memory:  ${ghToken ? `\x1b[32mgithub.com/${ghOwner}/0agent-memory\x1b[0m` : '\x1b[2mlocal only\x1b[0m'}`);
  console.log(`  Sandbox: \x1b[36m${sandboxChoice}\x1b[0m`);
  console.log(`  Seed:    \x1b[36m${seedName ?? 'scratch'}\x1b[0m\n`);

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
    api_key: "${apiKey || ''}"
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
${ghToken && ghOwner ? `\ngithub_memory:\n  enabled: true\n  token: "${ghToken}"\n  owner: "${ghOwner}"\n  repo: "${ghRepo}"` : ''}
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

  // Find the bundled daemon — ships as dist/daemon.mjs in the npm package
  const pkgRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');
  const bundled  = resolve(pkgRoot, 'dist', 'daemon.mjs');
  const devPath  = resolve(pkgRoot, 'packages', 'daemon', 'dist', 'start.js');
  const startScript = existsSync(bundled) ? bundled : devPath;

  if (!existsSync(startScript)) {
    console.error(`  Daemon not found. Run: node scripts/bundle.mjs\n  Then try again.`);
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

  const WS = await importWS();

  return new Promise((resolve) => {
    const ws = new WS(`ws://localhost:4200/ws`);
    let streaming = false;  // true when mid-token-stream

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'subscribe', topics: ['sessions'] }));
    });

    ws.on('message', (data) => {
      try {
        const event = JSON.parse(data.toString());
        if (event.session_id !== sessionId) return;

        switch (event.type) {
          case 'session.step':
            // Newline before step if we were mid-stream
            if (streaming) { process.stdout.write('\n'); streaming = false; }
            console.log(`  \x1b[2m›\x1b[0m ${event.step}`);
            break;
          case 'session.token':
            // Token-by-token streaming — print without newline
            if (!streaming) { process.stdout.write('\n  '); streaming = true; }
            process.stdout.write(event.token);
            break;
          case 'session.completed': {
            if (streaming) { process.stdout.write('\n'); streaming = false; }
            const r = event.result ?? {};
            if (r.files_written?.length) console.log(`\n  \x1b[32m✓\x1b[0m Files: ${r.files_written.join(', ')}`);
            if (r.commands_run?.length) console.log(`  \x1b[32m✓\x1b[0m Commands run: ${r.commands_run.length}`);
            if (r.tokens_used) console.log(`  \x1b[2m${r.tokens_used} tokens · ${r.model}\x1b[0m`);
            console.log('\n  \x1b[32m✓ Done\x1b[0m\n');
            await showResultPreview(r);   // confirm server/file actually exists
            ws.close();
            resolve();
            break;
          }
          case 'session.failed':
            if (streaming) { process.stdout.write('\n'); streaming = false; }
            console.log(`\n  \x1b[31m✗ Failed:\x1b[0m ${event.error}\n`);
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
  let lastStepCount = 0;
  for (let i = 0; i < 300; i++) {
    await sleep(600);
    const res = await fetch(`${BASE_URL}/api/sessions/${sessionId}`);
    const s = await res.json();

    // Print any new steps since last poll
    const steps = s.steps ?? [];
    for (let j = lastStepCount; j < steps.length; j++) {
      console.log(`  › ${steps[j].description}`);
    }
    lastStepCount = steps.length;

    if (s.status === 'completed') {
      console.log('\n  ✓ Done\n');
      const out = s.result?.output ?? s.result;
      if (out && typeof out === 'string') console.log(`  ${out}\n`);
      await showResultPreview(s.result ?? {});
      return;
    }
    if (s.status === 'failed') {
      console.log(`\n  ✗ Failed: ${s.error}\n`);
      return;
    }
  }
  console.log('\n  Timed out waiting for session.\n');
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
      console.log('\n  Built-in skills:\n');
      for (const s of (Array.isArray(skills) ? skills : skills.skills ?? [])) {
        console.log(`  /${s.name.padEnd(22)} ${s.category?.padEnd(10) ?? ''.padEnd(10)} ${s.description}`);
      }
      console.log('\n  Anthropic skills (fetched on demand):\n');
      const anthropicSkills = ['pdf','docx','xlsx','pptx','web-artifacts-builder','webapp-testing','frontend-design','mcp-builder','algorithmic-art','brand-guidelines','doc-coauthoring','internal-comms','slack-gif-creator','theme-factory','canvas-design','skill-creator','claude-api'];
      for (const s of anthropicSkills) {
        console.log(`  /${s.padEnd(30)} fetched from github.com/anthropics/skills`);
      }
      console.log('\n  Usage: 0agent /<skill-name> or 0agent run "<task>" --skill <name>\n');
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
  // execSync already imported at top level via node:child_process
  execSync(`tail -${n} "${LOG_PATH}"`, { stdio: 'inherit' });
}

// ─── Help ─────────────────────────────────────────────────────────────────

// ─── Team commands ────────────────────────────────────────────────────────────

async function runTeamCommand(teamArgs) {
  const sub = teamArgs[0];
  const SYNC_URL = process.env['ZEROAGENT_SYNC'] ?? 'http://localhost:4201';

  switch (sub) {
    case 'create': {
      const name = teamArgs.slice(1).join(' ');
      if (!name) { console.log('  Usage: 0agent team create "<name>"'); break; }
      const res = await fetch(`${SYNC_URL}/api/teams`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          creator_entity_id: crypto.randomUUID(),
          creator_name: process.env['USER'] ?? 'User',
        }),
      }).catch(() => null);
      if (!res?.ok) { console.log(`  Sync server not running. Start it with: 0agent serve`); break; }
      const team = await res.json();
      console.log(`\n  ✓ Team created: ${team.name}`);
      console.log(`  Invite code:   \x1b[1m${team.invite_code}\x1b[0m`);
      console.log(`\n  Share with teammates:`);
      console.log(`    0agent team join ${team.invite_code} --server ${SYNC_URL}\n`);
      break;
    }

    case 'join': {
      const code = teamArgs[1]?.toUpperCase();
      const serverIdx = teamArgs.indexOf('--server');
      const serverUrl = serverIdx >= 0 ? teamArgs[serverIdx + 1] : SYNC_URL;
      if (!code) { console.log('  Usage: 0agent team join <CODE> [--server <url>]'); break; }
      const res = await fetch(`${serverUrl}/api/teams/by-code/${code}`).catch(() => null);
      if (!res?.ok) { console.log(`  Invalid code or sync server unreachable: ${serverUrl}`); break; }
      const team = await res.json();
      const joinRes = await fetch(`${serverUrl}/api/teams/${team.id}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entity_node_id: crypto.randomUUID(),
          name: process.env['USER'] ?? 'User',
        }),
      });
      if (!joinRes.ok) { console.log('  Failed to join team.'); break; }
      console.log(`\n  ✓ Joined: ${team.name}`);
      console.log(`  Members: ${team.members?.length ?? '?'}`);
      console.log(`  Sync server: ${serverUrl}\n`);
      break;
    }

    case 'list': {
      // Show teams from local teams.yaml
      const { readFileSync, existsSync } = await import('node:fs');
      const { resolve } = await import('node:path');
      const { homedir } = await import('node:os');
      const teamsPath = resolve(homedir(), '.0agent', 'teams.yaml');
      if (!existsSync(teamsPath)) { console.log('\n  No teams joined yet. Use: 0agent team join <CODE>\n'); break; }
      const YAML = await import('yaml');
      const config = YAML.parse(readFileSync(teamsPath, 'utf8'));
      console.log('\n  Your teams:\n');
      for (const m of (config.memberships ?? [])) {
        const ago = m.last_synced_at ? `synced ${Math.round((Date.now() - m.last_synced_at) / 60000)}m ago` : 'never synced';
        console.log(`  ${m.team_name.padEnd(24)} ${m.invite_code}  ${ago}`);
        console.log(`  ${' '.repeat(24)} ${m.server_url}`);
      }
      console.log();
      break;
    }

    default:
      console.log('  Usage: 0agent team create "<name>" | join <CODE> [--server <url>] | list');
  }
}

// ─── Serve command (sync server + optional tunnel) ────────────────────────────

async function runServe(serveArgs) {
  const hasTunnel = serveArgs.includes('--tunnel');
  const port = parseInt(serveArgs.find(a => a.match(/^\d+$/)) ?? '4201', 10);

  console.log(`\n  Starting 0agent sync server on port ${port}...\n`);

  // Find sync server entry point
  const { resolve, dirname } = await import('node:path');
  const { existsSync } = await import('node:fs');
  const { spawn } = await import('node:child_process');
  const { networkInterfaces } = await import('node:os');

  const pkgRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');
  const serverScript = resolve(pkgRoot, 'packages', 'sync-server', 'src', 'index.ts');

  if (!existsSync(serverScript)) {
    console.log('  Sync server not found in package. Install with: npm install -g 0agent');
    return;
  }

  // Start sync server
  const proc = spawn(process.execPath, ['--experimental-specifier-resolution=node', serverScript], {
    env: { ...process.env, SYNC_PORT: String(port), SYNC_HOST: '0.0.0.0' },
    stdio: 'inherit',
    detached: false,
  });

  // Get LAN IP
  const nets = networkInterfaces();
  let lanIp = '127.0.0.1';
  for (const iface of Object.values(nets)) {
    if (!iface) continue;
    for (const net of iface) {
      if (net.family === 'IPv4' && !net.internal) { lanIp = net.address; break; }
    }
  }

  await sleep(1500);

  const localUrl = `http://localhost:${port}`;
  const lanUrl   = `http://${lanIp}:${port}`;

  console.log(`\n  ✓ Sync server running`);
  console.log(`  Local:  ${localUrl}`);
  console.log(`  LAN:    ${lanUrl}  ← share with teammates on same WiFi`);

  if (hasTunnel) {
    console.log('\n  Opening public tunnel...');
    let tunnelUrl = null;

    // Try cloudflared
    try {
      const { execSync: es } = await import('node:child_process');
      es('which cloudflared', { stdio: 'ignore' });
      const cf = spawn('cloudflared', ['tunnel', '--url', localUrl], { stdio: ['ignore', 'pipe', 'pipe'] });
      cf.unref();
      tunnelUrl = await waitForTunnelUrl(cf, /https:\/\/[a-z0-9\-]+\.trycloudflare\.com/i, 12000);
    } catch {}

    // Try ngrok
    if (!tunnelUrl) {
      try {
        const { execSync: es } = await import('node:child_process');
        es('which ngrok', { stdio: 'ignore' });
        const ng = spawn('ngrok', ['http', String(port), '--log=stdout'], { stdio: ['ignore', 'pipe', 'pipe'] });
        ng.unref();
        tunnelUrl = await waitForTunnelUrl(ng, /https:\/\/[a-z0-9\-]+\.ngrok/i, 8000);
      } catch {}
    }

    if (tunnelUrl) {
      console.log(`  Public: \x1b[1m${tunnelUrl}\x1b[0m  ← share with anyone`);
      const code = Math.random().toString(36).slice(2,5).toUpperCase() + '-' + Math.floor(1000+Math.random()*9000);
      console.log(`\n  Share this with teammates:`);
      console.log(`    0agent team join <CODE> --server ${tunnelUrl}\n`);
    } else {
      console.log('  No tunnel tool found. Install cloudflared: brew install cloudflared');
      console.log('  Using LAN only.');
    }
  }

  console.log('\n  Press Ctrl+C to stop.\n');
  proc.on('close', () => process.exit(0));
}

async function waitForTunnelUrl(proc, pattern, timeout) {
  return new Promise(resolve => {
    const chunks = [];
    const onData = d => {
      const s = d.toString(); chunks.push(s);
      const match = chunks.join('').match(pattern);
      if (match) { cleanup(); resolve(match[0]); }
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    const timer = setTimeout(() => { cleanup(); resolve(null); }, timeout);
    const cleanup = () => { clearTimeout(timer); proc.stdout?.removeListener('data', onData); proc.stderr?.removeListener('data', onData); };
  });
}

// ─── Memory sync (GitHub backend) ─────────────────────────────────────────

async function runMemoryCommand(memArgs) {
  const sub = memArgs[0] ?? 'status';

  switch (sub) {
    // ── 0agent memory connect github ──────────────────────────────────────
    case 'connect': {
      const provider = memArgs[1] ?? 'github';
      if (provider !== 'github') { console.log('  Only GitHub is supported: 0agent memory connect github'); break; }

      console.log('\n  \x1b[1m0agent Memory — GitHub Sync\x1b[0m\n');
      console.log('  Your knowledge graph will be backed up to a private GitHub repository.');
      console.log('  Free, versioned, cross-device. No server needed.\n');

      // ── Authentication ──
      let token = '';

      // Try gh CLI first (already logged in for most devs)
      try {
        const { execSync: ex } = await import('node:child_process');
        token = ex('gh auth token 2>/dev/null', { encoding: 'utf8' }).trim();
        if (token) {
          const { execSync: ex2 } = await import('node:child_process');
          const user = ex2('gh api user --jq .login 2>/dev/null', { encoding: 'utf8' }).trim();
          console.log(`  \x1b[32m✓\x1b[0m Detected gh CLI — authenticated as \x1b[1m${user}\x1b[0m`);
        }
      } catch {}

      // Fallback: GitHub Device Flow
      if (!token) {
        console.log('  \x1b[2mgh CLI not found — using GitHub token auth\x1b[0m\n');
        console.log('  Create a token at: \x1b[4mhttps://github.com/settings/tokens/new\x1b[0m');
        console.log('  Required scope: \x1b[1mrepo\x1b[0m\n');
        token = await ask('  Paste token (starts with ghp_): ');
        token = token.trim();
        if (!token) { console.log('  No token provided.'); break; }
      }

      // Verify token
      const owner = await verifyGitHubToken(token);
      if (!owner) { console.log('  \x1b[31m✗\x1b[0m Invalid token or no access.'); break; }
      console.log(`  \x1b[32m✓\x1b[0m Authenticated as \x1b[1m${owner}\x1b[0m`);

      // ── Create repo ──
      const repoName = memArgs[2] ?? '0agent-memory';
      process.stdout.write(`  Creating private repo \x1b[1m${owner}/${repoName}\x1b[0m...`);
      const created = await createGitHubRepo(token, repoName);
      console.log(created ? ' \x1b[32m✓\x1b[0m' : ' \x1b[33m(already exists)\x1b[0m');

      // ── Save to config ──
      const YAML = await import('yaml');
      const { readFileSync: rf, writeFileSync: wf, existsSync: ef } = await import('node:fs');
      if (ef(CONFIG_PATH)) {
        let cfg = rf(CONFIG_PATH, 'utf8');
        // Remove old github_memory block if present
        cfg = cfg.replace(/\ngithub_memory:[\s\S]*?(?=\n\w|\n$|$)/, '');
        cfg += `\ngithub_memory:\n  enabled: true\n  token: "${token}"\n  owner: "${owner}"\n  repo: "${repoName}"\n`;
        wf(CONFIG_PATH, cfg, 'utf8');
      }

      // ── Initial push ──
      console.log('\n  Performing initial sync...');
      await requireDaemon();
      const result = await daemonMemorySync('push');
      if (result?.pushed) {
        console.log(`  \x1b[32m✓\x1b[0m Synced — ${result.nodes_synced} nodes, ${result.edges_synced} edges`);
        console.log(`\n  Memory repo: \x1b[4mhttps://github.com/${owner}/${repoName}\x1b[0m`);
        console.log('\n  From any machine, run:');
        console.log(`    \x1b[36m0agent memory connect github --repo ${owner}/${repoName}\x1b[0m\n`);
      } else {
        console.log('  \x1b[33m⚠\x1b[0m Initial sync skipped — run `0agent memory sync` after daemon starts.');
        console.log(`\n  Memory repo: \x1b[4mhttps://github.com/${owner}/${repoName}\x1b[0m\n`);
      }
      break;
    }

    // ── 0agent memory sync ────────────────────────────────────────────────
    case 'sync': {
      await requireDaemon();
      process.stdout.write('  Syncing memory to GitHub...');
      const result = await daemonMemorySync('push');
      if (result?.pushed) {
        console.log(` \x1b[32m✓\x1b[0m  ${result.nodes_synced} nodes, ${result.edges_synced} edges`);
      } else {
        console.log(` \x1b[31m✗\x1b[0m  ${result?.error ?? 'No GitHub memory configured'}`);
        if (!result?.error) console.log('  Run: 0agent memory connect github');
      }
      break;
    }

    // ── 0agent memory pull ───────────────────────────────────────────────
    case 'pull': {
      await requireDaemon();
      process.stdout.write('  Pulling memory from GitHub...');
      const result = await daemonMemorySync('pull');
      if (result?.pulled) {
        console.log(` \x1b[32m✓\x1b[0m  +${result.nodes_synced} nodes, +${result.edges_synced} edges merged`);
      } else {
        console.log(` \x1b[31m✗\x1b[0m  ${result?.error ?? 'No GitHub memory configured'}`);
      }
      break;
    }

    // ── 0agent memory status ──────────────────────────────────────────────
    case 'status': {
      const YAML = await import('yaml');
      const { readFileSync: rf, existsSync: ef } = await import('node:fs');
      if (!ef(CONFIG_PATH)) { console.log('\n  Not initialised. Run: 0agent init\n'); break; }

      const cfg = YAML.parse(rf(CONFIG_PATH, 'utf8'));
      const ghMem = cfg.github_memory;

      if (!ghMem?.enabled) {
        console.log('\n  Memory sync: \x1b[33mnot connected\x1b[0m');
        console.log('  Run: 0agent memory connect github\n');
      } else {
        console.log(`\n  Memory sync: \x1b[32m✓ connected\x1b[0m`);
        console.log(`  Repo:  https://github.com/${ghMem.owner}/${ghMem.repo}`);
        // Get last sync from daemon
        try {
          const res = await fetch(`${BASE_URL}/api/memory/status`).catch(() => null);
          const data = res?.ok ? await res.json() : null;
          if (data) {
            console.log(`  Last push: ${data.pushed_at ? new Date(data.pushed_at).toLocaleString() : 'never'}`);
            console.log(`  Last pull: ${data.pulled_at ? new Date(data.pulled_at).toLocaleString() : 'never'}`);
          }
        } catch {}
        console.log();
      }
      break;
    }

    // ── 0agent memory disconnect ──────────────────────────────────────────
    case 'disconnect': {
      const { readFileSync: rf, writeFileSync: wf, existsSync: ef } = await import('node:fs');
      if (ef(CONFIG_PATH)) {
        let cfg = rf(CONFIG_PATH, 'utf8');
        cfg = cfg.replace(/\ngithub_memory:[\s\S]*?(?=\n\w|\n$|$)/, '');
        wf(CONFIG_PATH, cfg, 'utf8');
      }
      console.log('  \x1b[32m✓\x1b[0m GitHub memory sync disabled. Local graph unchanged.');
      break;
    }

    default:
      console.log('  Usage: 0agent memory connect github | sync | pull | status | disconnect');
  }
}

async function verifyGitHubToken(token) {
  try {
    const res = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': '0agent/1.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const user = await res.json();
    return user.login;
  } catch { return null; }
}

async function createGitHubRepo(token, repoName) {
  const res = await fetch('https://api.github.com/user/repos', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': '0agent/1.0' },
    body: JSON.stringify({
      name: repoName,
      description: '0agent memory — knowledge graph backed up automatically',
      private: true,
      auto_init: true,
    }),
    signal: AbortSignal.timeout(10000),
  });
  return res.ok || res.status === 422; // 422 = already exists
}

async function daemonMemorySync(direction) {
  try {
    const res = await fetch(`${BASE_URL}/api/memory/${direction}`, { method: 'POST' });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// ─── Result preview — confirms the agent's work actually ran ────────────────

async function showResultPreview(result) {
  if (!result) return;
  const files = result.files_written ?? [];
  const cmds  = result.commands_run  ?? [];
  const out   = result.output        ?? '';

  // 1. Server check — if a port was mentioned, verify HTTP response
  const allText = [...cmds, out].join(' ');
  const portMatch = allText.match(/(?:localhost:|port\s*[=:]?\s*)(\d{4,5})/i);
  if (portMatch) {
    const port = parseInt(portMatch[1], 10);
    await sleep(1200); // give server a moment to bind
    try {
      const res = await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(2500) });
      const body = await res.text();
      const preview = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
      console.log(`  \x1b[32m⬡ Confirmed live:\x1b[0m http://localhost:${port} (HTTP ${res.status})`);
      if (preview) console.log(`  \x1b[2m${preview}\x1b[0m`);
    } catch {
      // Server not up yet — non-fatal, ExecutionVerifier already handled this
    }
  }

  // 2. File preview — show first few lines of the most significant created file
  if (files.length > 0) {
    const mainFile = files.find(f => /\.(html|jsx?|tsx?|py|rs|go|md|css|json)$/.test(f)) ?? files[0];
    try {
      const { readFileSync } = await import('node:fs');
      const { resolve: res } = await import('node:path');
      const fullPath = res(process.env['ZEROAGENT_CWD'] ?? process.cwd(), mainFile);
      const content  = readFileSync(fullPath, 'utf8');
      const lines    = content.split('\n').slice(0, 6).join('\n');
      console.log(`\n  \x1b[2m── ${mainFile} ─────────────────────────────────\x1b[0m`);
      console.log(`  \x1b[2m${lines}\x1b[0m`);
      if (content.split('\n').length > 6) console.log(`  \x1b[2m...\x1b[0m`);
    } catch {}
  }

  console.log();
}

// ─── Watch mode — ambient intelligence ──────────────────────────────────────

async function runWatch() {
  // Ensure daemon is running (auto-starts if needed)
  await requireDaemon();

  const { basename } = await import('node:path');
  const cwdName = basename(process.cwd());

  // Header
  console.log(`\n  \x1b[1m0agent\x1b[0m watching \x1b[36m${cwdName}\x1b[0m`);
  console.log(`  ${'─'.repeat(42)}`);

  // Show current graph state
  try {
    const h = await fetch(`${BASE_URL}/api/health`).then(r => r.json()).catch(() => null);
    if (h) {
      console.log(`  Graph:  ${h.graph_nodes ?? 0} nodes · ${h.graph_edges ?? 0} edges`);
      console.log(`  Uptime: ${Math.round((h.uptime_ms ?? 0) / 60000)}m · Sandbox: ${h.sandbox_backend ?? '—'}`);
    }
  } catch {}

  // Show any unseen insights immediately
  try {
    const insights = await fetch(`${BASE_URL}/api/insights?seen=false`).then(r => r.json()).catch(() => []);
    if (Array.isArray(insights) && insights.length > 0) {
      console.log(`\n  \x1b[33m${insights.length} unseen insight${insights.length > 1 ? 's' : ''}:\x1b[0m`);
      for (const ins of insights.slice(0, 3)) {
        const icon = ins.type === 'test_failure' ? '\x1b[31m●\x1b[0m' : ins.type === 'git_anomaly' ? '\x1b[33m⚡\x1b[0m' : '\x1b[36m◆\x1b[0m';
        console.log(`  ${icon} ${ins.summary}`);
        if (ins.suggested_action) console.log(`    \x1b[2m→ ${ins.suggested_action}\x1b[0m`);
      }
    } else {
      console.log(`\n  Watching for insights...`);
    }
  } catch {}

  console.log(`\n  \x1b[2mPress Enter to run suggested action · q to quit\x1b[0m\n`);

  // Connect WebSocket for live events
  const WS = await importWS();
  let lastSuggestion = null;
  let ws;

  const connect = () => {
    ws = new WS(`ws://localhost:4200/ws`);

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'subscribe', topics: ['sessions', 'graph', 'insights', 'stats'] }));
    });

    ws.on('message', (data) => {
      try {
        const event = JSON.parse(data.toString());
        const ts = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

        switch (event.type) {
          case 'agent.insight': {
            const ins = event.insight ?? {};
            const icon = ins.type === 'test_failure' ? '\x1b[31m● test\x1b[0m'
              : ins.type === 'git_anomaly'   ? '\x1b[33m⚡ git\x1b[0m'
              : '\x1b[36m◆ insight\x1b[0m';
            console.log(`  [${ts}] ${icon}  ${ins.summary}`);
            if (ins.suggested_action) {
              console.log(`          \x1b[36m→ ${ins.suggested_action}\x1b[0m`);
              lastSuggestion = ins.suggested_action;
            }
            break;
          }
          case 'session.completed':
            console.log(`  [${ts}] \x1b[32m✓\x1b[0m  Session completed`);
            break;
          case 'session.failed':
            console.log(`  [${ts}] \x1b[31m✗\x1b[0m  Session failed: ${event.error}`);
            break;
          case 'graph.weight_updated':
            // Subtle learning indicator — one dot per weight change
            process.stdout.write('\x1b[2m·\x1b[0m');
            break;
          case 'team.synced':
            console.log(`  [${ts}] \x1b[35m⬡\x1b[0m  Team synced (↑${event.deltas_pushed ?? 0} ↓${event.deltas_pulled ?? 0})`);
            break;
        }
      } catch {}
    });

    ws.on('error', () => {});
    ws.on('close', () => {
      setTimeout(connect, 3000); // reconnect on daemon restart
    });
  };

  connect();

  // Keyboard handling — Enter = act, q = quit
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', async (key) => {
      if (key === '\u0003' || key === 'q') { // Ctrl+C or q
        process.stdout.write('\n');
        ws?.close();
        process.stdin.setRawMode(false);
        process.exit(0);
      }
      if (key === '\r' && lastSuggestion) {
        // Extract executable part from suggestion
        const cmd = lastSuggestion.match(/(?:0agent\s+)?(\/?[\w-]+(?:\s+"[^"]*")?)/);
        if (cmd) {
          process.stdout.write('\n');
          const parts = cmd[1].trim().split(/\s+/);
          if (parts[0].startsWith('/')) {
            await runSkill(parts[0].slice(1), parts.slice(1));
          } else if (parts[0] === 'run' || !['start','stop','init','chat'].includes(parts[0])) {
            await runTask(parts[0] === 'run' ? parts.slice(1) : parts);
          }
          lastSuggestion = null;
        }
      }
    });
  } else {
    // Non-interactive: just watch, no keyboard
    process.on('SIGINT', () => { ws?.close(); process.exit(0); });
    await new Promise(() => {}); // run forever
  }
}

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

  Team collaboration:
    0agent serve                   Start sync server (LAN)
    0agent serve --tunnel          Start sync server + public tunnel
    0agent team create "<name>"    Create a team, get invite code
    0agent team join <CODE>        Join a team by invite code
    0agent team list               List your teams

  Dashboard:
    http://localhost:4200           Web UI (after starting daemon)

  Examples:
    0agent run "fix the auth bug"
    0agent /research "Acme Corp funding"
    0agent /build --task next
    0agent /qa --url https://staging.myapp.com
    0agent serve --tunnel          # then share the URL + 0agent team join <CODE>
    0agent watch                   # ambient mode — live insights, press Enter to act

  Auto-start:
    The daemon auto-starts on first 0agent run. No need for 0agent start.
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
  if (await isDaemonRunning()) return;

  // Auto-start if config exists — no manual `0agent start` needed
  if (!existsSync(CONFIG_PATH)) {
    console.log('\n  Not initialised. Run: 0agent init\n');
    process.exit(1);
  }

  process.stdout.write('  Starting daemon');
  await _startDaemonBackground();

  for (let i = 0; i < 24; i++) {
    await sleep(500);
    process.stdout.write('.');
    if (await isDaemonRunning()) {
      process.stdout.write(' ✓\n\n');
      return;
    }
  }
  process.stdout.write(' ✗\n');
  console.log('  Daemon failed to start. Check: 0agent logs\n');
  process.exit(1);
}

// Internal: spawn daemon process without printing the full startup banner
async function _startDaemonBackground() {
  const { resolve: res, dirname: dn, existsSync: ex } = await import('node:path').then(m => m);
  const pkgRoot   = res(dn(new URL(import.meta.url).pathname), '..');
  const bundled   = res(pkgRoot, 'dist', 'daemon.mjs');
  const devPath   = res(pkgRoot, 'packages', 'daemon', 'dist', 'start.js');
  const script    = ex(bundled) ? bundled : devPath;
  if (!ex(script)) return;

  mkdirSync(resolve(AGENT_DIR, 'logs'), { recursive: true });
  const child = spawn(process.execPath, [script], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ZEROAGENT_CONFIG: CONFIG_PATH },
  });
  child.unref();
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
