#!/usr/bin/env node
/**
 * 0agent Chat — persistent, streaming TUI.
 *
 * Stays open like Claude Code. Commands start with /.
 * Responses stream word-by-word. Subagents visible inline.
 * /model to switch. /key to add provider keys. Never forgets previous keys.
 */

import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import YAML from 'yaml';

const AGENT_DIR   = resolve(homedir(), '.0agent');
const CONFIG_PATH = resolve(AGENT_DIR, 'config.yaml');
const BASE_URL    = process.env['ZEROAGENT_URL'] ?? 'http://localhost:4200';

// ─── Spinner ──────────────────────────────────────────────────────────────────
class Spinner {
  constructor(msg = 'Thinking') {
    this._msg = msg;
    this._frames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
    this._i = 0; this._timer = null; this._active = false;
  }
  start(msg) {
    if (this._active) return;
    if (msg) this._msg = msg;
    this._active = true;
    this._timer = setInterval(() => {
      process.stdout.write(`\r  \x1b[36m${this._frames[this._i++ % this._frames.length]}\x1b[0m \x1b[2m${this._msg}\x1b[0m  `);
    }, 80);
  }
  update(msg) { this._msg = msg; }
  stop(clearIt = true) {
    if (!this._active) return;
    clearInterval(this._timer); this._timer = null; this._active = false;
    if (clearIt) process.stdout.write('\r\x1b[2K');
  }
  get active() { return this._active; }
}

// ─── ANSI helpers ─────────────────────────────────────────────────────────────
const C = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  cyan:    '\x1b[36m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  red:     '\x1b[31m',
  blue:    '\x1b[34m',
  magenta: '\x1b[35m',
  white:   '\x1b[37m',
};
const fmt = (color, text) => `${color}${text}${C.reset}`;
const clearLine = () => process.stdout.write('\r\x1b[2K');

// ─── LLM ping — direct 1-token call, bypasses daemon, instant ────────────────
async function pingLLM(provider) {
  const key   = provider.api_key ?? '';
  const model = provider.model;
  const sig   = AbortSignal.timeout(8000);

  try {
    if (provider.provider === 'anthropic') {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal: sig,
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      });
      const d = await r.json();
      if (!r.ok) return { ok: false, error: d.error?.message ?? `HTTP ${r.status}` };
      return { ok: true, model: d.model };
    }

    if (['openai','xai','gemini'].includes(provider.provider)) {
      const base = provider.provider === 'xai' ? 'https://api.x.ai/v1'
        : provider.provider === 'gemini' ? 'https://generativelanguage.googleapis.com/v1beta/openai'
        : 'https://api.openai.com/v1';
      const r = await fetch(`${base}/chat/completions`, {
        method: 'POST', signal: sig,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      });
      const d = await r.json();
      if (!r.ok) return { ok: false, error: d.error?.message ?? `HTTP ${r.status}` };
      return { ok: true, model: d.model };
    }

    if (provider.provider === 'ollama') {
      const base = provider.base_url ?? 'http://localhost:11434';
      const r = await fetch(`${base}/api/generate`, {
        method: 'POST', signal: sig,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt: 'hi', stream: false }),
      });
      if (!r.ok) return { ok: false, error: `Ollama HTTP ${r.status}` };
      return { ok: true, model };
    }

    return { ok: true, model }; // unknown provider — skip check
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ─── Config management ────────────────────────────────────────────────────────
function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return null;
  try { return YAML.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch { return null; }
}

function saveConfig(cfg) {
  writeFileSync(CONFIG_PATH, YAML.stringify(cfg), 'utf8');
}

function getCurrentProvider(cfg) {
  const def = cfg?.llm_providers?.find(p => p.is_default) ?? cfg?.llm_providers?.[0];
  return def ?? null;
}

// ─── State ────────────────────────────────────────────────────────────────────
let cfg         = loadConfig();
let sessionId      = null;
let streaming      = false;
let ws             = null;
let wsReady        = false;
let pendingResolve = null;
let lineBuffer     = '';
const spinner      = new Spinner('Thinking');
const history   = [];    // command history for arrow keys

// ─── Header ──────────────────────────────────────────────────────────────────
function printHeader() {
  const provider = getCurrentProvider(cfg);
  const modelStr = provider ? `${provider.provider}/${provider.model}` : 'no model';
  console.log();
  console.log(fmt(C.bold, '  0agent') + fmt(C.dim, ` — ${modelStr}`));
  console.log(fmt(C.dim, '  Type a task, or /help for commands. Ctrl+C to exit.\n'));
}

function printInsights() {
  fetch(`${BASE_URL}/api/insights?seen=false`)
    .then(r => r.json())
    .then(insights => {
      if (!Array.isArray(insights) || insights.length === 0) return;
      console.log(fmt(C.yellow, `  ${insights.length} insight${insights.length > 1 ? 's' : ''} since last session:`));
      for (const ins of insights.slice(0, 2)) {
        console.log(`  ${fmt(C.dim, '›')} ${ins.summary}`);
        if (ins.suggested_action) console.log(`    ${fmt(C.cyan, '→')} ${fmt(C.dim, ins.suggested_action)}`);
      }
      console.log();
    })
    .catch(() => {});
}

// ─── WebSocket ────────────────────────────────────────────────────────────────
async function connectWS() {
  try {
    const { default: WS } = await import('ws').catch(() => ({ default: globalThis.WebSocket }));
    ws = new WS(`ws://localhost:4200/ws`);
    ws.on('open', () => {
      wsReady = true;
      ws.send(JSON.stringify({ type: 'subscribe', topics: ['sessions', 'graph', 'insights'] }));
    });
    ws.on('message', data => handleWsEvent(JSON.parse(data.toString())));
    ws.on('close', () => { wsReady = false; setTimeout(connectWS, 2000); });
    ws.on('error', () => { wsReady = false; });
  } catch {}
}

function handleWsEvent(event) {
  if (!sessionId || event.session_id !== sessionId) return;

  switch (event.type) {
    case 'session.step': {
      spinner.stop();
      if (streaming) { process.stdout.write('\n'); streaming = false; }
      console.log(`  ${fmt(C.dim, '›')} ${event.step}`);
      spinner.start(event.step.slice(0, 50));  // resume with current step label
      break;
    }
    case 'session.token': {
      spinner.stop();
      if (!streaming) { process.stdout.write('\n  '); streaming = true; }
      process.stdout.write(event.token);
      lineBuffer += event.token;
      break;
    }
    case 'session.completed': {
      spinner.stop();
      if (streaming) { process.stdout.write('\n'); streaming = false; }
      const r = event.result ?? {};
      if (r.files_written?.length) console.log(`\n  ${fmt(C.green, '✓')} ${r.files_written.join(', ')}`);
      if (r.tokens_used) process.stdout.write(fmt(C.dim, `\n  ${r.tokens_used} tokens · ${r.model ?? ''}\n`));

      // Confirm server if port mentioned
      confirmServer(r, lineBuffer);
      lineBuffer = '';
      if (pendingResolve) { pendingResolve(); pendingResolve = null; }
      rl.prompt();
      break;
    }
    case 'session.failed': {
      spinner.stop();
      if (streaming) { process.stdout.write('\n'); streaming = false; }
      console.log(`\n  ${fmt(C.red, '✗')} ${event.error}\n`);
      lineBuffer = '';
      if (pendingResolve) { pendingResolve(); pendingResolve = null; }
      rl.prompt();
      break;
    }
    case 'agent.insight': {
      // Show insight inline, non-interruptive
      const ins = event.insight ?? {};
      process.stdout.write(`\n  ${fmt(C.yellow, '◆')} ${ins.summary}\n`);
      if (ins.suggested_action) process.stdout.write(`    ${fmt(C.dim, `→ ${ins.suggested_action}`)}\n`);
      if (!streaming) rl.prompt(true);
      break;
    }
    case 'graph.weight_updated': {
      // Subtle dot — graph is learning
      process.stdout.write(fmt(C.dim, '·'));
      break;
    }
  }
}

async function confirmServer(result, output) {
  const allText = [...(result.commands_run ?? []), output].join(' ');
  const portMatch = allText.match(/(?:localhost:|port\s*[=:]?\s*)(\d{4,5})/i);
  if (!portMatch) return;
  const port = parseInt(portMatch[1], 10);
  await new Promise(r => setTimeout(r, 1200));
  try {
    const res = await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(2000) });
    console.log(`\n  ${fmt(C.green, '⬡')} Live at ${fmt(C.cyan, `http://localhost:${port}`)} (HTTP ${res.status})`);
  } catch {}
}

// ─── Task submission ──────────────────────────────────────────────────────────
async function runTask(input) {
  let skillName, entityId;
  let task = input;

  // Parse inline flags: --skill /review, --entity sahil
  const skillMatch = task.match(/--skill\s+([\w-]+)/);
  if (skillMatch) { skillName = skillMatch[1]; task = task.replace(skillMatch[0], '').trim(); }
  const entityMatch = task.match(/--entity\s+([\w-]+)/);
  if (entityMatch) { entityId = entityMatch[1]; task = task.replace(entityMatch[0], '').trim(); }

  // Slash-prefix → skill
  if (task.startsWith('/') && !task.startsWith('/model') && !task.startsWith('/key')) {
    const parts = task.split(/\s+/);
    skillName = parts[0].slice(1);
    task = parts.slice(1).join(' ') || `Run the /${skillName} skill`;
  }

  const body = { task, ...(skillName && { skill: skillName }), ...(entityId && { entity_id: entityId }) };

  try {
    const res = await fetch(`${BASE_URL}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const s = await res.json();
    sessionId = s.session_id ?? s.id;
    spinner.start('Thinking');  // show immediately after session created
    return new Promise(resolve => { pendingResolve = resolve; });
  } catch (e) {
    console.log(`  ${fmt(C.red, '✗')} ${e.message}`);
  }
}

// ─── Commands ─────────────────────────────────────────────────────────────────
async function handleCommand(input) {
  const parts = input.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();

  switch (cmd) {
    // /model — list or switch model
    case '/model': {
      if (!cfg) { console.log(fmt(C.red, '  No config found. Run: 0agent init')); break; }
      const providers = cfg.llm_providers ?? [];
      const current = getCurrentProvider(cfg);

      if (parts.length === 1) {
        // List current + available
        console.log('\n  Current model:');
        console.log(`    ${fmt(C.green, '●')} ${current?.provider}/${current?.model}\n`);
        console.log('  All configured providers:');
        for (const p of providers) {
          const marker = p.is_default ? fmt(C.green, '●') : fmt(C.dim, '○');
          console.log(`    ${marker} ${p.provider}/${p.model}`);
        }
        console.log('\n  ' + fmt(C.dim, 'Usage: /model anthropic claude-opus-4-6'));
        console.log('  ' + fmt(C.dim, '       /model openai gpt-4o'));
        console.log('  ' + fmt(C.dim, '       /model add anthropic sk-ant-...') + '\n');
      } else if (parts[1] === 'add') {
        // /model add <provider> <api-key>
        const provider = parts[2];
        const key = parts[3];
        if (!provider || !key) { console.log(fmt(C.red, '  Usage: /model add <provider> <api-key>')); break; }
        const defaultModels = { anthropic: 'claude-sonnet-4-6', openai: 'gpt-4o', xai: 'grok-3', gemini: 'gemini-2.0-flash', ollama: 'llama3.1' };
        const existing = providers.findIndex(p => p.provider === provider);
        if (existing >= 0) {
          cfg.llm_providers[existing].api_key = key;
          console.log(`  ${fmt(C.green, '✓')} Updated ${provider} API key`);
        } else {
          cfg.llm_providers.push({ provider, model: defaultModels[provider] ?? provider, api_key: key, is_default: false });
          console.log(`  ${fmt(C.green, '✓')} Added ${provider}`);
        }
        saveConfig(cfg);
        console.log(`  ${fmt(C.dim, 'Restart daemon for changes to take effect: 0agent stop && 0agent start')}\n`);
      } else {
        // /model <provider> <model>  OR  /model <provider>
        const provider = parts[1];
        const model    = parts[2];
        // Set as default
        for (const p of providers) p.is_default = false;
        const match = providers.find(p => p.provider === provider);
        if (match) {
          match.is_default = true;
          if (model) match.model = model;
          saveConfig(cfg);
          cfg = loadConfig();
          console.log(`  ${fmt(C.green, '✓')} Switched to ${fmt(C.cyan, `${provider}/${match.model}`)}`);
          console.log(`  ${fmt(C.dim, 'Restart daemon to apply: 0agent stop && 0agent start\n')}`);
        } else {
          console.log(`  ${fmt(C.red, '✗')} Provider "${provider}" not found. Add it first with:`);
          console.log(`  ${fmt(C.dim, `/model add ${provider} <api-key>`)}\n`);
        }
      }
      break;
    }

    // /key — add or list API keys
    case '/key': {
      if (!cfg) { console.log(fmt(C.red, '  No config found. Run: 0agent init')); break; }
      if (parts.length === 1) {
        // List masked keys
        console.log('\n  Stored API keys:\n');
        for (const p of cfg.llm_providers ?? []) {
          const masked = p.api_key ? p.api_key.slice(0, 10) + '••••••' : fmt(C.dim, '(not set)');
          console.log(`    ${p.provider.padEnd(12)} ${masked}`);
        }
        console.log('\n  ' + fmt(C.dim, 'Usage: /key <provider> <api-key>') + '\n');
      } else {
        const provider = parts[1];
        const key      = parts[2];
        if (!key) { console.log(fmt(C.red, `  Usage: /key ${provider} <api-key>`)); break; }
        const match = cfg.llm_providers?.find(p => p.provider === provider);
        if (match) {
          match.api_key = key;
          saveConfig(cfg);
          cfg = loadConfig();
          console.log(`  ${fmt(C.green, '✓')} ${provider} key updated (${key.slice(0, 8)}••••)\n`);
        } else {
          console.log(`  ${fmt(C.yellow, '⚠')} "${provider}" not configured. Use /model add ${provider} ${key}\n`);
        }
      }
      break;
    }

    // /status
    case '/status': {
      try {
        const h = await fetch(`${BASE_URL}/api/health`).then(r => r.json());
        console.log(`\n  ${fmt(C.green, '✓')} Daemon running`);
        console.log(`  Graph:    ${h.graph_nodes} nodes · ${h.graph_edges} edges`);
        console.log(`  Sessions: ${h.active_sessions} active`);
        console.log(`  Sandbox:  ${h.sandbox_backend}\n`);
      } catch {
        console.log(`  ${fmt(C.red, '✗')} Daemon not running. Run: 0agent start\n`);
      }
      break;
    }

    // /skills
    case '/skills': {
      try {
        const skills = await fetch(`${BASE_URL}/api/skills`).then(r => r.json());
        const list = Array.isArray(skills) ? skills : skills.skills ?? [];
        console.log('\n  Available skills:\n');
        for (const s of list.slice(0, 15)) {
          console.log(`  ${fmt(C.cyan, `/${s.name.padEnd(20)}`)} ${fmt(C.dim, s.description?.slice(0, 55) ?? '')}`);
        }
        if (list.length > 15) console.log(fmt(C.dim, `  ... and ${list.length - 15} more\n`));
        else console.log();
      } catch { console.log(fmt(C.dim, '  Daemon not running\n')); }
      break;
    }

    // /graph
    case '/graph': {
      console.log(`  ${fmt(C.cyan, 'Knowledge graph:')} ${fmt(C.dim, 'http://localhost:4200')}\n`);
      try {
        const { execSync } = await import('node:child_process');
        execSync('open http://localhost:4200 2>/dev/null || xdg-open http://localhost:4200 2>/dev/null', { stdio: 'ignore' });
      } catch {}
      break;
    }

    // /clear
    case '/clear':
      process.stdout.write('\x1b[2J\x1b[H');
      printHeader();
      break;

    // /help
    case '/help':
    default: {
      console.log('\n  Commands:\n');
      const cmds = [
        ['/model',          'Show or switch model (/model openai gpt-4o)'],
        ['/model add',      'Add provider key (/model add anthropic sk-ant-...)'],
        ['/key <provider>', 'Update stored API key'],
        ['/status',         'Daemon health + graph stats'],
        ['/skills',         'List available skills'],
        ['/graph',          'Open 3D knowledge graph in browser'],
        ['/clear',          'Clear screen'],
        ['/<skill>',        'Run a skill (/review, /build, /qa, /debug...)'],
        ['Ctrl+C',          'Exit'],
      ];
      for (const [c, d] of cmds) {
        console.log(`  ${fmt(C.cyan, c.padEnd(20))} ${fmt(C.dim, d)}`);
      }
      console.log();
      break;
    }
  }
}

// ─── Main REPL ────────────────────────────────────────────────────────────────
const rl = createInterface({
  input:  process.stdin,
  output: process.stdout,
  prompt: `\n  ${fmt(C.cyan, '›')} `,
  historySize: 100,
  completer: (line) => {
    const commands = ['/model', '/key', '/status', '/skills', '/graph', '/clear', '/help',
      '/review', '/build', '/debug', '/qa', '/research', '/refactor', '/test-writer', '/retro'];
    const hits = commands.filter(c => c.startsWith(line));
    return [hits.length ? hits : commands, line];
  },
});

// Restore history from conversations if possible
rl.on('history', () => {});

printHeader();
printInsights();

// Connect WebSocket for live events
connectWS();

// ── Startup: ensure fresh daemon + verify LLM ────────────────────────────────
async function _spawnDaemon() {
  const pkgRoot = resolve(new URL(import.meta.url).pathname, '..', '..');
  const bundled  = resolve(pkgRoot, 'dist', 'daemon.mjs');
  if (!existsSync(bundled) || !existsSync(CONFIG_PATH)) return false;
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [bundled], {
    detached: true, stdio: 'ignore',
    env: { ...process.env, ZEROAGENT_CONFIG: CONFIG_PATH },
  });
  child.unref();
  // Wait up to 10s for daemon to be ready
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(500) });
      return true;
    } catch {}
  }
  return false;
}

async function _safeJsonFetch(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  try { return { status: res.status, data: JSON.parse(text) }; }
  catch { return { status: res.status, data: null, raw: text }; }
}

(async () => {
  const startSpin = new Spinner('Starting daemon');

  // Step 1: Check if daemon is running AND up-to-date (has /api/llm/ping)
  let daemonOk = false;
  let needsRestart = false;

  try {
    await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(1500) });
    // Daemon running — check if it has the new /api/llm/ping route
    const probe = await _safeJsonFetch(`${BASE_URL}/api/llm/ping`, {
      method: 'POST', signal: AbortSignal.timeout(3000),
    });
    if (probe.status === 404 || probe.data === null) {
      // Old daemon without this route — needs restart
      needsRestart = true;
    } else {
      daemonOk = true;
    }
  } catch {
    // Daemon not running at all
  }

  if (needsRestart) {
    startSpin.start('Restarting daemon (new version)');
    // Kill old daemon
    try {
      const { execSync } = await import('node:child_process');
      execSync('pkill -f "daemon.mjs" 2>/dev/null; true', { stdio: 'ignore' });
    } catch {}
    await new Promise(r => setTimeout(r, 800));
    daemonOk = await _spawnDaemon();
  } else if (!daemonOk) {
    startSpin.start('Starting daemon');
    daemonOk = await _spawnDaemon();
  }

  startSpin.stop();
  if (!daemonOk) {
    console.log(`  ${fmt(C.red, '✗')} Daemon failed to start. Run: 0agent start`);
    rl.prompt();
    return;
  }
  if (needsRestart) {
    process.stdout.write(`  ${fmt(C.green, '✓')} Daemon updated\n`);
  } else if (!daemonOk) {
    process.stdout.write(`  ${fmt(C.green, '✓')} Daemon ready\n`);
  } else {
    // Was already running and up to date — show nothing (already running)
    process.stdout.write(`  ${fmt(C.green, '✓')} Daemon ready\n`);
  }

  // Step 2: LLM check via daemon (not direct — this proves daemon↔API works)
  const provider = getCurrentProvider(cfg);
  const llmSpin = new Spinner(`Checking ${provider?.provider ?? 'LLM'}/${provider?.model ?? '...'}`);
  llmSpin.start();
  try {
    const { data } = await _safeJsonFetch(`${BASE_URL}/api/llm/ping`, {
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
    });
    llmSpin.stop();
    if (data?.ok) {
      console.log(`  ${fmt(C.green, '✓')} ${fmt(C.cyan, (data.provider ?? '') + '/' + (data.model ?? ''))} — ${data.latency_ms}ms\n`);
    } else if (data) {
      console.log(`  ${fmt(C.red, '✗')} LLM error: ${data.error}`);
      console.log(`  ${fmt(C.dim, 'Fix: /key ' + (provider?.provider ?? 'anthropic') + ' <api-key>')}\n`);
    } else {
      console.log(`  ${fmt(C.yellow, '⚠')} LLM ping returned unexpected response\n`);
    }
  } catch (e) {
    llmSpin.stop();
    console.log(`  ${fmt(C.yellow, '⚠')} LLM check failed: ${e.message}\n`);
  }

  rl.prompt();
})();


rl.on('line', async (input) => {
  const line = input.trim();
  if (!line) { rl.prompt(); return; }

  if (line.startsWith('/') || ['/model','/key','/status','/skills','/graph','/clear','/help'].some(c => line.startsWith(c))) {
    await handleCommand(line);
    rl.prompt();
  } else {
    await runTask(line);
    // prompt() is called from WS handler after session.completed
    // but fall back if WS not connected
    if (!wsReady) rl.prompt();
  }
});

rl.on('close', () => {
  console.log(`\n  ${fmt(C.dim, 'Goodbye.')}\n`);
  process.exit(0);
});

process.on('SIGINT', () => {
  if (pendingResolve) {
    // Session in progress — cancel it, don't exit
    process.stdout.write(`\n  ${fmt(C.yellow, '↩')} Cancelled\n`);
    spinner.stop();
    if (sessionId) {
      fetch(`${BASE_URL}/api/sessions/${sessionId}`, { method: 'DELETE' }).catch(() => {});
    }
    const resolve_ = pendingResolve;
    pendingResolve = null;
    sessionId = null;
    resolve_();
    rl.prompt();
  } else {
    // Not busy — show hint on first press
    process.stdout.write(`\n  ${fmt(C.dim, 'Press Ctrl+C again to exit')}\n`);
    rl.prompt();
    // Second Ctrl+C within 1.5s exits
    const timeout = setTimeout(() => {}, 1500);
    process.once('SIGINT', () => { clearTimeout(timeout); process.exit(0); });
  }
});
