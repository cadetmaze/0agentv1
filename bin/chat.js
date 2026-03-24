#!/usr/bin/env node
/**
 * 0agent Chat — persistent, streaming TUI.
 *
 * Stays open like Claude Code. Commands start with /.
 * Responses stream word-by-word. Subagents visible inline.
 * /model to switch. /key to add provider keys. Never forgets previous keys.
 */

import { createInterface, emitKeypressEvents } from 'node:readline';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import YAML from 'yaml';

// ─── Slash command registry (used for live menu + tab completion) ─────────────
const SLASH_COMMANDS = [
  // Skills
  { cmd: '/review',        desc: 'Code review — bugs, style, security issues'     },
  { cmd: '/build',         desc: 'Build project and fix compilation errors'        },
  { cmd: '/qa',            desc: 'Generate and run tests'                          },
  { cmd: '/debug',         desc: 'Debug a failing test or runtime error'           },
  { cmd: '/refactor',      desc: 'Refactor a file or module'                       },
  { cmd: '/test-writer',   desc: 'Write unit tests for your code'                  },
  { cmd: '/doc',           desc: 'Generate documentation'                          },
  { cmd: '/research',      desc: 'Research a topic, person, or company'            },
  { cmd: '/retro',         desc: 'Weekly retrospective — what went well / badly'   },
  { cmd: '/ship',          desc: 'Pre-release checklist — ready to deploy?'        },
  { cmd: '/office-hours',  desc: 'Plan a new feature or project from scratch'      },
  { cmd: '/plan-eng-review',desc:'Engineering planning review'                     },
  { cmd: '/security-audit',desc: 'Security audit — find vulnerabilities'           },
  { cmd: '/design-review', desc: 'Design review — architecture and patterns'       },
  // Built-ins
  { cmd: '/memory',        desc: 'Show graph nodes and force-push to GitHub'        },
  { cmd: '/telegram',      desc: 'Connect Telegram bot — forward messages to 0agent'},
  { cmd: '/model',         desc: 'Show or switch the LLM model'                   },
  { cmd: '/key',           desc: 'Update a stored API key'                         },
  { cmd: '/status',        desc: 'Daemon health, graph stats, active sessions'     },
  { cmd: '/skills',        desc: 'List all available skills'                       },
  { cmd: '/schedule',      desc: 'Manage scheduled / recurring tasks'              },
  { cmd: '/update',        desc: 'Update 0agent to the latest version'             },
  { cmd: '/graph',         desc: 'Open 3D knowledge graph in browser'              },
  { cmd: '/clear',         desc: 'Clear the screen'                                },
  { cmd: '/help',          desc: 'Show this help'                                  },
];

const AGENT_DIR   = resolve(homedir(), '.0agent');
const CONFIG_PATH = resolve(AGENT_DIR, 'config.yaml');
const BASE_URL    = process.env['ZEROAGENT_URL'] ?? 'http://localhost:4200';

// ─── Spinner ──────────────────────────────────────────────────────────────────
class Spinner {
  constructor(msg = 'Thinking') {
    this._msg = msg;
    this._frames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
    this._i = 0; this._timer = null; this._active = false;
    this._sessionMode = false; // true during agent sessions — no \r animation
  }

  // Animated spinner — safe only at startup when user cannot type yet.
  // Uses \r which conflicts with readline when user is typing.
  start(msg) {
    if (this._active) return;
    if (msg) this._msg = msg;
    this._active = true;
    this._sessionMode = false;
    this._timer = setInterval(() => {
      process.stdout.write(`\r  \x1b[36m${this._frames[this._i++ % this._frames.length]}\x1b[0m \x1b[2m${this._msg}\x1b[0m  `);
    }, 80);
  }

  // Session mode — prints a one-time static status line, NO \r animation.
  // readline owns the cursor; call rl.prompt(true) after this to show › .
  startSession(msg) {
    if (this._active) return;
    if (msg) this._msg = msg;
    this._active = true;
    this._sessionMode = true;
    process.stdout.write(`  \x1b[2m⠋ ${this._msg}...\x1b[0m\n`);
  }

  update(msg) { this._msg = msg; }

  stop(clearIt = true) {
    if (!this._active) return;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    const wasSession = this._sessionMode;
    this._active = false;
    this._sessionMode = false;
    // Only clear the \r-based animation line; session mode output flows naturally
    if (clearIt && !wasSession) {
      process.stdout.write('\r\x1b[2K');
    }
  }

  get active() { return this._active; }

  // Pause to print something cleanly, then resume.
  pauseFor(fn) {
    const wasActive  = this._active;
    const wasSession = this._sessionMode;
    const savedMsg   = this._msg;
    this.stop(!wasSession); // clear animated spinner; session mode: just deactivate
    fn();
    if (wasActive) {
      if (wasSession) {
        // Re-mark active without printing again — readline is showing the prompt
        this._active = true;
        this._sessionMode = true;
        this._msg = savedMsg;
      } else {
        this.start(savedMsg);
      }
    }
  }
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

// ─── Markdown renderer ────────────────────────────────────────────────────────
// Applied to the full streamed response at session.completed — rewrites raw
// LLM output with ANSI formatting (bold, code, headers, bullets).
function renderMarkdown(text) {
  const lines = text.split('\n');
  const out   = [];
  let inCode  = false;
  let codeLang = '';

  for (const raw of lines) {
    if (raw.startsWith('```')) {
      inCode = !inCode;
      codeLang = inCode ? raw.slice(3).trim() : '';
      if (!inCode) out.push(''); // blank after code block
      continue;
    }
    if (inCode) {
      out.push(`  \x1b[36m${raw}\x1b[0m`);
      continue;
    }

    let line = raw;

    // Headers
    if      (line.startsWith('### ')) line = `\x1b[1m${line.slice(4)}\x1b[0m`;
    else if (line.startsWith('## '))  line = `\x1b[1;4m${line.slice(3)}\x1b[0m`;
    else if (line.startsWith('# '))   line = `\x1b[1;4m${line.slice(2)}\x1b[0m`;
    // Bullets
    else if (/^[-*] /.test(line))     line = `  \x1b[36m·\x1b[0m ${line.slice(2)}`;
    else if (/^\d+\. /.test(line))    line = `  ${line}`;
    // Horizontal rule
    else if (/^-{3,}$/.test(line))    line = `\x1b[2m${'─'.repeat(54)}\x1b[0m`;

    // Inline: bold, code, italic
    line = line
      .replace(/\*\*([^*\n]+)\*\*/g, '\x1b[1m$1\x1b[0m')
      .replace(/`([^`\n]+)`/g,        '\x1b[36m$1\x1b[0m')
      .replace(/\*([^*\s][^*\n]*)\*/g,'\x1b[3m$1\x1b[0m');

    out.push('  ' + line);
  }
  return out.join('\n');
}

// ─── Step formatter ───────────────────────────────────────────────────────────
// Converts raw step labels from AgentExecutor into icon + clean readable form.
function formatStep(step) {
  const ICONS = {
    shell_exec:   `\x1b[33m⚡\x1b[0m`,
    file_op:      `\x1b[34m◈\x1b[0m`,
    web_search:   `\x1b[35m⌕\x1b[0m`,
    scrape_url:   `\x1b[35m◎\x1b[0m`,
    memory_write: `\x1b[32m◆\x1b[0m`,
    browser_open: `\x1b[34m◉\x1b[0m`,
  };

  // Tool call: "▶ shell_exec("cmd")"
  const toolMatch = step.match(/^▶\s+(\w+)\((.{0,100})\)/);
  if (toolMatch) {
    const [, tool, args] = toolMatch;
    const icon = ICONS[tool] ?? fmt(C.dim, '›');
    const clean = args.replace(/^["'](.*)["']$/, '$1').replace(/\\n/g, ' ').slice(0, 72);
    return `  ${icon} \x1b[2m${clean}\x1b[0m`;
  }

  // Result: "  ↳ text"
  if (/^\s*↳/.test(step)) {
    const text = step.replace(/^\s*↳\s*/, '');
    return `    \x1b[2m↳ ${text.slice(0, 100)}\x1b[0m`;
  }

  // Thinking / Continuing (suppress — replaced by startSession static status)
  if (/^(Thinking|Continuing)/.test(step)) return null;

  // Summary lines (Done, Files written, Commands run)
  if (/^(Done|Files|Commands)/.test(step))
    return `  \x1b[2m${step}\x1b[0m`;

  return `  \x1b[2m› ${step}\x1b[0m`;
}

// ─── Cost estimator ───────────────────────────────────────────────────────────
function estimateCost(model, tokens) {
  const RATES = { // $ per 1M tokens (blended in+out)
    'claude-sonnet-4-6': 4.0, 'claude-opus-4-6': 22.0, 'claude-haiku-4-5': 0.5,
    'gpt-4o': 5.0, 'gpt-4o-mini': 0.2, 'grok-3': 3.0,
    'gemini-2.0-flash': 0.12, 'gemini-2.0-pro': 3.5,
  };
  if (!model || !tokens) return '';
  const key = Object.keys(RATES).find(k => String(model).includes(k));
  if (!key) return '';
  const usd = (tokens / 1_000_000) * RATES[key];
  return usd < 0.01 ? ' · <$0.01' : ` · $${usd.toFixed(3)}`;
}

// ─── OS notification ──────────────────────────────────────────────────────────
async function notifyDone(task, success) {
  try {
    const { execSync } = await import('node:child_process');
    const title = success ? '0agent ✓' : '0agent ✗';
    const body  = task.replace(/'/g, '').slice(0, 80);
    if (process.platform === 'darwin') {
      execSync(`osascript -e 'display notification "${body}" with title "${title}"'`,
               { stdio: 'ignore', timeout: 3000 });
    } else if (process.platform === 'linux') {
      execSync(`notify-send "${title}" "${body}" 2>/dev/null`,
               { stdio: 'ignore', timeout: 3000 });
    }
  } catch {}
}

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
let cfg            = loadConfig();
let sessionId      = null;
const messageQueue = [];       // queued tasks while session is running
let lastFailedTask = null;     // for retry-on-abort
let streaming      = false;
let streamLineCount = 0;       // newlines printed during streaming (for re-render)
let ws             = null;
let wsReady        = false;
let pendingResolve = null;
let lineBuffer     = '';
let currentTask    = '';       // task being executed (for notifications)
let sessionStartMs = 0;        // when current session started (for elapsed time)
const spinner      = new Spinner('Thinking');
const history      = [];       // command history for arrow keys

// ─── Header ──────────────────────────────────────────────────────────────────
function printHeader() {
  const provider = getCurrentProvider(cfg);
  const modelStr = provider ? `${provider.provider}/${provider.model}` : 'no model';
  const ws       = cfg?.workspace?.path ?? null;
  console.log();
  console.log(`  ${fmt(C.bold, '0agent')} ${fmt(C.dim, '·')} ${fmt(C.cyan, modelStr)}`);
  if (ws) console.log(fmt(C.dim, `  ${ws}`));
  console.log(fmt(C.dim, '\n  Type a task, or / for commands.\n'));
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
    ws.on('close', () => { wsReady = false; setTimeout(connectWS, 800); }); // faster reconnect
    ws.on('error', () => { wsReady = false; });
  } catch {}
}

function handleWsEvent(event) {
  if (!sessionId || event.session_id !== sessionId) return;

  switch (event.type) {
    case 'session.step': {
      spinner.stop();
      if (streaming) { process.stdout.write('\n'); streaming = false; streamLineCount = 0; }
      const formatted = formatStep(event.step);
      if (formatted !== null) {
        process.stdout.write('\r\x1b[2K');
        console.log(formatted);
      }
      spinner.startSession(event.step.slice(0, 50));
      rl.prompt(true);
      break;
    }
    case 'session.token': {
      spinner.stop();
      if (!streaming) {
        process.stdout.write('\r\x1b[2K\n');
        streaming = true;
        streamLineCount = 1;
      }
      process.stdout.write(event.token);
      lineBuffer += event.token;
      streamLineCount += (event.token.match(/\n/g) || []).length;
      break;
    }
    case 'runtime.heal_proposal': {
      // Daemon found a code bug and is proposing a fix — requires human y/n
      const p = event.proposal ?? {};
      process.stdout.write('\n');
      process.stdout.write(`  ${fmt(C.yellow, '🔧 Runtime code bug detected')}\n`);
      process.stdout.write(`  ${fmt(C.dim, p.error_summary ?? '')}\n`);
      process.stdout.write(`  ${fmt(C.dim, 'File: ' + (p.location?.relPath ?? 'unknown'))}\n\n`);

      if (p.explanation) {
        process.stdout.write(`  ${fmt(C.bold, 'Diagnosis:')} ${p.explanation}\n\n`);
      }

      if (p.diff) {
        process.stdout.write(`  ${fmt(C.bold, 'Proposed fix:')}\n`);
        const diffLines = String(p.diff).split('\n');
        for (const line of diffLines) {
          if (line.startsWith('-')) process.stdout.write(`  ${fmt(C.red, line)}\n`);
          else if (line.startsWith('+')) process.stdout.write(`  ${fmt(C.green, line)}\n`);
          else process.stdout.write(`  ${fmt(C.dim, line)}\n`);
        }
        process.stdout.write('\n');
      }

      const confidence = p.confidence ?? 'medium';
      const confColor = confidence === 'high' ? C.green : confidence === 'medium' ? C.yellow : C.red;
      process.stdout.write(`  Confidence: ${fmt(confColor, confidence.toUpperCase())}\n\n`);

      // Ask for approval — use readline in raw mode for single keypress
      process.stdout.write(`  Apply this fix and restart daemon? ${fmt(C.bold, '[y/N]')} `);

      const handleHealApproval = async (key) => {
        process.stdin.removeListener('keypress', handleHealApproval);
        const answer = key?.toLowerCase() ?? 'n';
        process.stdout.write(answer + '\n\n');

        if (answer === 'y') {
          // Store proposal then approve
          await fetch(`${BASE_URL}/api/runtime/proposals`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(p),
          }).catch(() => {});

          const approveRes = await fetch(`${BASE_URL}/api/runtime/proposals/${p.proposal_id}/approve`, {
            method: 'POST',
          }).catch(() => null);
          const data = approveRes?.ok ? await approveRes.json().catch(() => null) : null;

          if (data?.applied) {
            process.stdout.write(`  ${fmt(C.green, '✓')} Patch applied. ${data.message}\n`);
            process.stdout.write(`  ${fmt(C.dim, 'Daemon restarting — reconnecting in 5s...')}\n\n`);
          } else {
            process.stdout.write(`  ${fmt(C.red, '✗')} Could not apply: ${data?.message ?? 'unknown error'}\n\n`);
            rl.prompt();
          }
        } else {
          await fetch(`${BASE_URL}/api/runtime/proposals/${p.proposal_id}`, { method: 'DELETE' }).catch(() => {});
          process.stdout.write(`  ${fmt(C.dim, 'Fix rejected. The bug remains.')}\n\n`);
          rl.prompt();
        }
      };

      // Listen for a single keypress
      if (process.stdin.isTTY) {
        process.stdin.once('data', (buf) => {
          handleHealApproval(buf.toString().trim().toLowerCase());
        });
      } else {
        rl.once('line', (line) => handleHealApproval(line.trim().toLowerCase()));
      }
      break;
    }

    case 'schedule.fired': {
      // Show when a scheduled job fires — even if user is idle
      const ts = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      process.stdout.write(`\n  ${fmt(C.magenta, '⏰')} [${ts}] Scheduled: ${fmt(C.bold, event.job_name)} — ${event.task}\n`);
      if (!streaming) rl.prompt(true);
      break;
    }
    case 'session.completed': {
      spinner.stop();

      // Re-render streamed response with markdown (rewind cursor, clear, reprint)
      if (streaming) {
        const rendered = renderMarkdown(lineBuffer.trim());
        const rewound  = streamLineCount + 1;
        process.stdout.write(`\x1b[${rewound}A\x1b[0J`); // move up + clear to end
        process.stdout.write(rendered + '\n');
        streaming = false;
        streamLineCount = 0;
      }

      const r       = event.result ?? {};
      const elapsed = sessionStartMs ? `${((Date.now() - sessionStartMs) / 1000).toFixed(1)}s` : '';
      const cost    = estimateCost(r.model, r.tokens_used);

      if (r.files_written?.length)
        console.log(`\n  ${fmt(C.green, '✓')} ${r.files_written.join(', ')}`);

      // Stats line: tokens · model · elapsed · cost
      if (r.tokens_used) {
        process.stdout.write(fmt(C.dim,
          `\n  ${r.tokens_used.toLocaleString()} tokens · ${r.model ?? ''}${elapsed ? ` · ${elapsed}` : ''}${cost}\n`));
      }

      // Contextual next-step suggestions
      const suggestions = _suggestNext(lineBuffer, r);
      if (suggestions.length > 0 && messageQueue.length === 0) {
        process.stdout.write(
          `  ${fmt(C.dim, '→')} ${suggestions.map(s => fmt(C.cyan, s)).join(fmt(C.dim, '  ·  '))}\n`
        );
      }

      // OS notification for tasks that took > 8s (user may have switched windows)
      if (sessionStartMs && Date.now() - sessionStartMs > 8000) {
        notifyDone(currentTask, true);
      }

      confirmServer(r, lineBuffer);
      lineBuffer = '';
      if (pendingResolve) { pendingResolve(); pendingResolve = null; }
      sessionId = null;
      drainQueue();
      break;
    }
    case 'session.failed': {
      spinner.stop();
      if (streaming) { process.stdout.write('\n'); streaming = false; streamLineCount = 0; }
      if (sessionStartMs && Date.now() - sessionStartMs > 8000) notifyDone(currentTask, false);
      const isAbort = /aborted|timeout|AbortError/i.test(event.error ?? '');
      console.log(`\n  ${fmt(C.red, '✗')} ${event.error}\n`);
      // Offer retry if it was a timeout/abort
      if (isAbort && event.task) {
        lastFailedTask = event.task;
        process.stdout.write(`  ${fmt(C.yellow, '↺')} Retry this task? ${fmt(C.bold, '[y/N]')} `);
        process.stdin.once('data', async (buf) => {
          const ans = buf.toString().trim().toLowerCase();
          process.stdout.write(ans + '\n');
          if (ans === 'y' && lastFailedTask) {
            messageQueue.unshift(lastFailedTask); // put at front of queue
            lastFailedTask = null;
          }
          const resolve_ = pendingResolve;
          pendingResolve = null; sessionId = null;
          resolve_?.();
          await drainQueue();
        });
        return; // don't fall through to pendingResolve below
      }
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

function _suggestNext(output, result) {
  const text = (output + ' ' + (result?.output ?? '') + ' ' + JSON.stringify(result?.files_written ?? [])).toLowerCase();
  if (text.includes('written') || text.includes('creat') || text.includes('built') || (result?.files_written?.length > 0)) {
    return ['/review', '/qa'];
  }
  if (text.includes('test') || text.includes('spec') || text.includes('pass')) {
    return ['/ship'];
  }
  if (text.includes('research') || text.includes('found') || text.includes('results')) {
    return ['/office-hours', '/doc'];
  }
  if (text.includes('bug') || text.includes('fix') || text.includes('error') || text.includes('debug')) {
    return ['/qa', '/review'];
  }
  if (text.includes('deploy') || text.includes('server') || text.includes('running')) {
    return ['/qa', '/ship'];
  }
  return [];
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
    sessionId      = s.session_id ?? s.id;
    sessionStartMs = Date.now();
    currentTask    = task;
    // Start session-mode status (no \r animation) then restore › so user can type
    process.stdout.write('\n');
    spinner.startSession('Thinking');
    rl.prompt(true); // keep › visible — user can queue next message while agent works

    // Polling fallback — runs concurrently with WS events.
    // Catches completion when WS is disconnected (e.g. daemon just restarted).
    let lastPolledStep = 0;
    const sid = sessionId;
    const sessionStart = Date.now();
    const pollTimer = setInterval(async () => {
      if (!pendingResolve || sessionId !== sid) { clearInterval(pollTimer); return; }

      // Hard cap: if session runs for > 2 minutes, force-unblock the chat.
      // The daemon session may still run in background, but the user gets their prompt back.
      if (Date.now() - sessionStart > 120_000) {
        clearInterval(pollTimer);
        spinner.stop();
        console.log(`\n  \x1b[33m⚠\x1b[0m Session still running in background (> 2min). Chat unblocked.\n`);
        const res = pendingResolve;
        pendingResolve = null;
        sessionId = null;
        res();
        rl.prompt();
        return;
      }
      try {
        const r = await fetch(`${BASE_URL}/api/sessions/${sid}`, { signal: AbortSignal.timeout(2000) });
        const session = await r.json();

        // Show any new steps not yet shown via WS
        const steps = session.steps ?? [];
        for (let j = lastPolledStep; j < steps.length; j++) {
          spinner.stop();
          const formatted = formatStep(steps[j].description);
          if (formatted !== null) {
            process.stdout.write('\r\x1b[2K');
            console.log(formatted);
          }
          spinner.startSession(steps[j].description.slice(0, 50));
          rl.prompt(true);
        }
        lastPolledStep = steps.length;

        if (session.status === 'completed' || session.status === 'failed') {
          clearInterval(pollTimer);
          if (!pendingResolve) return; // WS already handled it
          spinner.stop();
          if (session.status === 'completed') {
            const out = session.result?.output;
            if (out && typeof out === 'string') {
              console.log(`\n  ${out}`);
            }
            if (session.result?.files_written?.length) console.log(`  \x1b[32m✓\x1b[0m Files: ${session.result.files_written.join(', ')}`);
            if (session.result?.tokens_used) console.log(`  \x1b[2m${session.result.tokens_used} tokens\x1b[0m`);
            console.log(`\n  \x1b[32m✓ Done\x1b[0m\n`);
          } else {
            console.log(`\n  \x1b[31m✗ Failed:\x1b[0m ${session.error}\n`);
          }
          const resolve_ = pendingResolve;
          pendingResolve = null;
          sessionId = null;
          resolve_?.();
          drainQueue(); // auto-process queued messages
        }
      } catch {}
    }, 800);

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
    // /update — check for updates and install immediately
    case '/update': {
      process.stdout.write(`  ${fmt(C.dim, 'Checking for updates...')}\n`);
      try {
        const pkgPath = resolve(new URL(import.meta.url).pathname, '..', '..', 'package.json');
        const currentVersion = existsSync(pkgPath)
          ? JSON.parse(readFileSync(pkgPath, 'utf8')).version
          : '?';
        const reg = await fetch('https://registry.npmjs.org/0agent/latest', {
          signal: AbortSignal.timeout(5000),
        }).then(r => r.json()).catch(() => null);
        const latest = reg?.version;
        if (!latest) { console.log(`  ${fmt(C.yellow, '⚠')} Could not reach npm registry\n`); break; }
        if (!isNewerVersion(latest, currentVersion)) {
          console.log(`  ${fmt(C.green, '✓')} Already on latest (${currentVersion})\n`);
          break;
        }
        console.log(`  ${fmt(C.cyan, '↑')} Updating ${currentVersion} → ${latest}...`);
        const { execSync: exs } = await import('node:child_process');
        exs('npm install -g 0agent@latest --silent', { stdio: 'ignore', timeout: 120_000 });
        process.stdout.write(`  ${fmt(C.green, '✓')} Updated to ${latest} — restarting...\n\n`);
        await restartWithLatest();
      } catch (e) {
        console.log(`  ${fmt(C.red, '✗')} Update failed: ${e.message}\n`);
      }
      break;
    }

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
    // /schedule — cron-like job scheduler
    case '/schedule': {
      const schedArgs = parts.slice(1);
      const subCmd = schedArgs[0]?.toLowerCase() ?? 'list';

      if (subCmd === 'list' || schedArgs.length === 0) {
        const res = await fetch(`${BASE_URL}/api/schedule`).catch(() => null);
        const jobs = res?.ok ? await res.json().catch(() => []) : [];
        if (!Array.isArray(jobs) || jobs.length === 0) {
          console.log('\n  No scheduled jobs. Add one:\n  ' +
            fmt(C.dim, '/schedule add "run /retro" every Friday at 5pm') + '\n');
        } else {
          console.log('\n  Scheduled jobs:\n');
          for (const j of jobs) {
            const status = j.enabled ? fmt(C.green, '●') : fmt(C.dim, '○');
            const next = j.next_run_human ?? 'unknown';
            console.log(`  ${status} ${fmt(C.bold, j.id)}  ${j.name}`);
            console.log(`     ${fmt(C.dim, j.schedule_human + ' · next: ' + next)}`);
          }
          console.log();
        }
      } else if (subCmd === 'add') {
        // /schedule add "<task>" <schedule...>
        // Parse: extract quoted task, rest is schedule
        const rest = parts.slice(2).join(' ');
        const quoted = rest.match(/^"([^"]+)"\s+(.+)$/) || rest.match(/^'([^']+)'\s+(.+)$/);
        if (!quoted) {
          console.log(`  ${fmt(C.dim, 'Usage: /schedule add "<task>" <schedule>')}`);
          console.log(`  ${fmt(C.dim, 'Examples:')}`);
          console.log(`  ${fmt(C.cyan, '  /schedule add "run /retro" every Friday at 5pm')}`);
          console.log(`  ${fmt(C.cyan, '  /schedule add "run /review" every day at 9am')}`);
          console.log(`  ${fmt(C.cyan, '  /schedule add "check the build" in 2 hours')}\n`);
        } else {
          const task = quoted[1];
          const schedule = quoted[2];
          const res = await fetch(`${BASE_URL}/api/schedule`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ task, schedule }),
          }).catch(() => null);
          const data = res?.ok ? await res.json().catch(() => null) : null;
          if (data?.id) {
            console.log(`  ${fmt(C.green, '✓')} Scheduled: ${fmt(C.bold, data.name)}`);
            console.log(`  ${fmt(C.dim, data.schedule_human + ' · next: ' + data.next_run_human)}\n`);
          } else {
            console.log(`  ${fmt(C.red, '✗')} ${data?.error ?? 'Failed to create schedule'}\n`);
          }
        }
      } else if (subCmd === 'delete' || subCmd === 'remove') {
        const id = schedArgs[1];
        if (!id) { console.log('  Usage: /schedule delete <id>\n'); break; }
        const res = await fetch(`${BASE_URL}/api/schedule/${id}`, { method: 'DELETE' }).catch(() => null);
        const data = res?.ok ? await res.json().catch(() => null) : null;
        console.log(data?.ok
          ? `  ${fmt(C.green, '✓')} Deleted ${id}\n`
          : `  ${fmt(C.red, '✗')} ${data?.error ?? 'Not found'}\n`);
      } else if (subCmd === 'pause') {
        const id = schedArgs[1];
        if (!id) { console.log('  Usage: /schedule pause <id>\n'); break; }
        await fetch(`${BASE_URL}/api/schedule/${id}/pause`, { method: 'POST' });
        console.log(`  ${fmt(C.green, '✓')} Paused ${id}\n`);
      } else if (subCmd === 'resume') {
        const id = schedArgs[1];
        if (!id) { console.log('  Usage: /schedule resume <id>\n'); break; }
        await fetch(`${BASE_URL}/api/schedule/${id}/resume`, { method: 'POST' });
        console.log(`  ${fmt(C.green, '✓')} Resumed ${id}\n`);
      } else {
        console.log('  Usage: /schedule list | add "<task>" <schedule> | delete <id> | pause <id> | resume <id>\n');
      }
      break;
    }

    // /memory — inspect graph nodes + force GitHub sync
    case '/memory': {
      try {
        const sub = parts[1]?.toLowerCase();

        if (sub === 'sync' || sub === 'push') {
          process.stdout.write(`  ${fmt(C.dim, 'Pushing to GitHub...')}\n`);
          const res = await fetch(`${BASE_URL}/api/memory/push`, { method: 'POST' }).catch(() => null);
          const data = res?.ok ? await res.json().catch(() => null) : null;
          if (data?.pushed) {
            console.log(`  ${fmt(C.green, '✓')} Pushed ${data.nodes_synced} nodes, ${data.edges_synced} edges to GitHub\n`);
          } else {
            console.log(`  ${fmt(C.yellow, '⚠')} ${data?.error ?? 'Sync not configured or failed'}\n`);
          }
          break;
        }

        // Show memory nodes from graph
        const res = await fetch(`${BASE_URL}/api/graph/nodes?limit=200`).then(r => r.json()).catch(() => []);
        const nodes = Array.isArray(res) ? res : [];
        const memNodes = nodes.filter(n => n.id?.startsWith('memory:') || n.type === 'context');
        const total    = nodes.length;

        console.log(`\n  ${fmt(C.bold, 'Knowledge graph')} — ${total} nodes total, ${memNodes.length} memory nodes\n`);

        if (memNodes.length === 0) {
          console.log(`  ${fmt(C.dim, 'No memory nodes yet. Run a task — the agent will write facts here.')}\n`);
        } else {
          for (const n of memNodes.slice(0, 20)) {
            const content = n.metadata?.content ?? n.label;
            const type    = n.metadata?.type ?? n.type;
            console.log(`  ${fmt(C.cyan, n.label.padEnd(28))} ${fmt(C.dim, String(content).slice(0, 50))}`);
            console.log(`  ${fmt(C.dim, `  ${n.id}  [${type}]`)}`);
          }
          if (memNodes.length > 20) console.log(fmt(C.dim, `\n  …and ${memNodes.length - 20} more`));
        }
        console.log();
        console.log(`  ${fmt(C.dim, 'Force sync: /memory sync  ·  Dashboard: http://localhost:4200')}\n`);
      } catch {
        console.log(`  ${fmt(C.red, '✗')} Daemon not running\n`);
      }
      break;
    }

    // /telegram — configure Telegram bot token
    case '/telegram': {
      if (!cfg) { console.log(fmt(C.red, '  No config found. Run: 0agent init')); break; }
      const existingToken = cfg?.telegram?.token;
      if (existingToken) {
        console.log(`\n  Telegram bot: ${fmt(C.green, '✓ configured')}`);
        console.log(`  Token: ${existingToken.slice(0, 10)}••••`);
        console.log(`  ${fmt(C.dim, 'To update: /telegram <new-token>\n')}`);
      }
      const token = parts[1];
      if (!token) {
        if (!existingToken) {
          console.log('\n  Connect your Telegram bot to 0agent:\n');
          console.log(`  1. Create a bot: ${fmt(C.cyan, 'https://t.me/BotFather')} → /newbot`);
          console.log(`  2. Copy the token and run: ${fmt(C.cyan, '/telegram <token>')}`);
          console.log(`  3. Restart daemon: ${fmt(C.dim, '0agent stop && 0agent start')}\n`);
        }
        break;
      }
      if (!cfg.telegram) cfg.telegram = {};
      cfg.telegram.token = token;
      saveConfig(cfg);
      console.log(`  ${fmt(C.green, '✓')} Telegram token saved`);
      console.log(`  ${fmt(C.dim, 'Restart daemon for changes to take effect: 0agent stop && 0agent start\n')}`);
      break;
    }

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

// ─── Command palette ──────────────────────────────────────────────────────────
// Fully takes over stdin when open. No cursor tricks — pauses readline,
// reads raw bytes directly, draws with \x1b[NA\x1b[0J (up + clear-to-end).
// Returns the selected command string, or null if cancelled.

let _paletteOpen = false;

async function openPalette(initialFilter = '') {
  if (_paletteOpen || pendingResolve) return null;
  _paletteOpen = true;

  // Pause readline so it stops consuming stdin events
  rl.pause();
  // Resume the raw stream so our data handler receives bytes
  process.stdin.resume();
  if (process.stdin.isTTY) process.stdin.setRawMode(true);

  let filter  = initialFilter.toLowerCase();
  let idx     = 0;
  let scroll  = 0;  // top of the visible window
  let drawn   = 0;
  const PAGE  = 10; // visible rows at once

  const getItems = () => SLASH_COMMANDS.filter(c =>
    !filter || c.cmd.slice(1).startsWith(filter)
  );

  const paint = () => {
    if (drawn > 0) process.stdout.write(`\x1b[${drawn}A\x1b[0J`);

    const items = getItems();
    if (items.length === 0) { idx = 0; scroll = 0; }
    else {
      idx = Math.max(0, Math.min(idx, items.length - 1));
      // Keep selected item inside the visible window
      if (idx < scroll)           scroll = idx;
      if (idx >= scroll + PAGE)   scroll = idx - PAGE + 1;
    }

    const show  = items.slice(scroll, scroll + PAGE);
    const lines = [];

    lines.push(`  \x1b[2m${'─'.repeat(58)}\x1b[0m`);

    if (items.length === 0) {
      lines.push(`  \x1b[2m  no commands match "/${filter}"\x1b[0m`);
    } else {
      for (let i = 0; i < show.length; i++) {
        const m   = show[i];
        const sel = (scroll + i) === idx;
        if (sel) {
          lines.push(`  \x1b[36;1m›\x1b[0m \x1b[36;1m${m.cmd.padEnd(22)}\x1b[0m ${m.desc}`);
        } else {
          lines.push(`    \x1b[36m${m.cmd.padEnd(22)}\x1b[0m \x1b[2m${m.desc}\x1b[0m`);
        }
      }
    }

    // Scroll indicator
    if (items.length > PAGE) {
      const pct = Math.round(((scroll + PAGE / 2) / items.length) * 100);
      lines.push(`  \x1b[2m  ${idx + 1} / ${items.length}  (${pct}%)\x1b[0m`);
    }

    lines.push(`  \x1b[2m${'─'.repeat(58)}\x1b[0m`);
    lines.push(`  ${fmt(C.cyan, '/')}${filter}\x1b[K  \x1b[2m↑↓ scroll · Enter select · Esc cancel\x1b[0m`);

    process.stdout.write(lines.join('\n') + '\n');
    drawn = lines.length;
  };

  paint();

  return new Promise((resolve) => {
    const onData = (chunk) => {
      const s = chunk.toString();

      if (s === '\r' || s === '\n') {           // Enter — select
        const sel = getItems()[idx]?.cmd ?? null;
        finish(sel);
      } else if (s === '\x1b' || s === '\x03') { // Esc / Ctrl-C — cancel
        finish(null);
      } else if (s === '\x1b[A') {              // Up arrow
        idx = Math.max(0, idx - 1);
        paint();
      } else if (s === '\x1b[B') {              // Down arrow
        idx = Math.min(getItems().length - 1, idx + 1);
        paint();
      } else if (s === '\x7f' || s === '\x08') { // Backspace
        filter = filter.slice(0, -1);
        idx = 0; scroll = 0;
        paint();
      } else if (/^[a-z0-9\-_]$/i.test(s)) {   // Printable letter/digit/hyphen
        filter += s.toLowerCase();
        idx = 0; scroll = 0;
        paint();
      }
    };

    const finish = (selected) => {
      process.stdin.removeListener('data', onData);
      // Erase the palette
      if (drawn > 0) process.stdout.write(`\x1b[${drawn}A\x1b[0J`);
      drawn = 0;
      _paletteOpen = false;
      // Hand control back to readline
      rl.resume();
      resolve(selected);
    };

    process.stdin.on('data', onData);
  });
}

// ─── Main REPL ────────────────────────────────────────────────────────────────
const rl = createInterface({
  input:  process.stdin,
  output: process.stdout,
  prompt: `\n  ${fmt(C.cyan, '›')} `,
  historySize: 100,
  completer: (line, callback) => {
    if (!line.startsWith('/')) return callback(null, [[], line]);

    const filter  = line.slice(1).toLowerCase();
    const matches = SLASH_COMMANDS.filter(c => !filter || c.cmd.slice(1).startsWith(filter));

    // Single exact match — let readline silently auto-complete
    if (matches.length === 1) return callback(null, [[matches[0].cmd + ' '], line]);

    // Multiple (or bare /) — open interactive palette
    // Schedule after this tick so readline finishes its Tab handling first
    setImmediate(async () => {
      // Clear the typed fragment from the prompt line before opening palette
      process.stdout.write('\r\x1b[2K');
      const selected = await openPalette(filter);
      if (selected) {
        await executeInput(selected);
      } else {
        rl.prompt();
      }
    });
    return callback(null, [[], line]);
  },
});

// Trigger palette when user types exactly '/' and presses Tab or Enter isn't needed —
// the completer above handles Tab. For bare '/' + Enter, handled in rl.on('line') below.
//
// Escape key: cancel current session (like Ctrl+C but without exiting).
emitKeypressEvents(process.stdin, rl);
process.stdin.on('keypress', (_char, key) => {
  if (!key || _paletteOpen) return;
  if (key.name === 'escape' && pendingResolve) {
    // Cancel the running session cleanly
    process.stdout.write(`\r\x1b[2K\n  ${fmt(C.yellow, '↩')} Cancelled\n`);
    spinner.stop();
    if (sessionId) {
      fetch(`${BASE_URL}/api/sessions/${sessionId}`, { method: 'DELETE' }).catch(() => {});
    }
    const res = pendingResolve;
    pendingResolve = null;
    sessionId      = null;
    streaming      = false;
    streamLineCount = 0;
    messageQueue.length = 0; // also clear queue — fresh start
    res();
    rl.prompt();
  }
});

printHeader();
printInsights();

// Connect WebSocket for live events
connectWS();

// ── Startup: ensure fresh daemon + verify LLM ────────────────────────────────
async function _spawnDaemon() {
  const pkgRoot  = resolve(new URL(import.meta.url).pathname, '..', '..');
  const bundled  = resolve(pkgRoot, 'dist', 'daemon.mjs');
  const devPath  = resolve(pkgRoot, 'packages', 'daemon', 'dist', 'start.js');
  const daemonScript = existsSync(bundled) ? bundled : existsSync(devPath) ? devPath : null;

  if (!daemonScript) return 'no-bundle';
  if (!existsSync(CONFIG_PATH)) return 'no-config';

  const { spawn } = await import('node:child_process');
  const { openSync: fsOpen, mkdirSync: fsMkdir } = await import('node:fs');
  const logDir = resolve(AGENT_DIR, 'logs');
  fsMkdir(logDir, { recursive: true });
  const logFd = fsOpen(resolve(logDir, 'daemon.log'), 'w');

  const child = spawn(process.execPath, [daemonScript], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, ZEROAGENT_CONFIG: CONFIG_PATH },
  });
  child.unref();

  // Wait up to 10s for daemon to be ready
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(500) });
      return 'ok';
    } catch {}
  }
  return 'timeout';
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

  let spawnResult = 'ok';
  if (needsRestart) {
    startSpin.start('Restarting daemon (new version)');
    try {
      const { execSync } = await import('node:child_process');
      execSync('pkill -f "daemon.mjs" 2>/dev/null; true', { stdio: 'ignore' });
    } catch {}
    await new Promise(r => setTimeout(r, 800));
    spawnResult = await _spawnDaemon();
    daemonOk = spawnResult === 'ok';
  } else if (!daemonOk) {
    startSpin.start('Starting daemon');
    spawnResult = await _spawnDaemon();
    daemonOk = spawnResult === 'ok';
  }

  startSpin.stop();
  if (!daemonOk) {
    if (spawnResult === 'no-config') {
      console.log(`  ${fmt(C.yellow, '!')} Not configured yet. Run: ${fmt(C.bold, '0agent init')}`);
    } else if (spawnResult === 'no-bundle') {
      console.log(`  ${fmt(C.red, '✗')} Daemon bundle missing. Reinstall: ${fmt(C.bold, 'npm i -g 0agent@latest')}`);
    } else {
      const logPath = resolve(AGENT_DIR, 'logs', 'daemon.log');
      console.log(`  ${fmt(C.red, '✗')} Daemon failed to start. Check logs: ${fmt(C.dim, logPath)}`);
    }
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

  // ── Step 3: Workspace folder check ───────────────────────────────────────
  // If no workspace is configured, ask the user to set one now.
  // Then export memory (graph nodes) to that folder.
  await (async () => {
    const wsPath = cfg?.workspace?.path;
    if (wsPath) {
      // Already configured — just ensure the folder exists
      try { mkdirSync(wsPath, { recursive: true }); } catch {}
      return;
    }

    // No workspace configured — ask inline
    const { homedir: hd } = await import('node:os');
    const defaultWs = resolve(hd(), '0agent-workspace');

    process.stdout.write(`\n  ${fmt(C.yellow, '⚠')} No workspace folder configured.\n`);
    process.stdout.write(`  ${fmt(C.dim, 'The agent needs a folder to create and store files.')}\n\n`);

    // Temporarily close readline so we can read a raw line
    const wsInput = await new Promise((res) => {
      process.stdout.write(`  ${fmt(C.bold, 'Workspace path')} ${fmt(C.dim, `[${defaultWs}]`)}: `);
      rl.once('line', (line) => res(line.trim() || defaultWs));
    });

    const chosenPath = resolve(wsInput.replace(/^~/, hd()));
    try {
      mkdirSync(chosenPath, { recursive: true });
      process.stdout.write(`  ${fmt(C.green, '✓')} Created: ${fmt(C.cyan, chosenPath)}\n`);
    } catch (e) {
      process.stdout.write(`  ${fmt(C.red, '✗')} Could not create folder: ${e.message}\n`);
      return;
    }

    // Save workspace path to config
    if (!cfg) cfg = {};
    cfg.workspace = { path: chosenPath };
    saveConfig(cfg);
    process.stdout.write(`  ${fmt(C.green, '✓')} Workspace saved to config\n`);

    // Export memory (graph nodes) to workspace as a JSON snapshot
    try {
      const nodesRes = await fetch(`${BASE_URL}/api/graph/nodes?limit=9999`, {
        signal: AbortSignal.timeout(5000),
      });
      if (nodesRes.ok) {
        const nodes = await nodesRes.json();
        const count = Array.isArray(nodes) ? nodes.length : 0;
        if (count > 0) {
          const exportPath = resolve(chosenPath, '.0agent-memory.json');
          writeFileSync(exportPath, JSON.stringify({ exported_at: new Date().toISOString(), nodes }, null, 2), 'utf8');
          process.stdout.write(`  ${fmt(C.green, '✓')} Memory exported: ${fmt(C.dim, `${count} nodes → .0agent-memory.json`)}\n`);
        }
      }
    } catch {}

    process.stdout.write('\n');
  })();

  // ── Auto-update: check npm, update silently, restart ─────────────────────
  // Runs in background after prompt — never blocks startup.
  // If update found: counts down 3s (press any key to skip), then auto-installs.
  (async () => {
    try {
      const pkgPath = resolve(new URL(import.meta.url).pathname, '..', '..', 'package.json');
      const currentVersion = existsSync(pkgPath)
        ? JSON.parse(readFileSync(pkgPath, 'utf8')).version
        : null;
      if (!currentVersion) return;

      const reg = await fetch('https://registry.npmjs.org/0agent/latest', {
        signal: AbortSignal.timeout(5000),
      }).then(r => r.json()).catch(() => null);

      const latest = reg?.version;
      if (!latest || !isNewerVersion(latest, currentVersion)) return;

      // Show banner immediately above current prompt line
      process.stdout.write(`\n  ${fmt(C.yellow, '↑')} New version ${fmt(C.bold, latest)} available (you have ${currentVersion})\n`);

      // 3-second countdown — press any key to skip, otherwise auto-updates
      let skipped = false;
      const skipHandler = () => { skipped = true; };
      process.stdin.once('data', skipHandler);

      for (let i = 3; i > 0; i--) {
        if (skipped) break;
        process.stdout.write(`\r  ${fmt(C.dim, `Auto-updating in ${i}s — press any key to skip...  `)}`);
        await new Promise(r => setTimeout(r, 1000));
      }
      process.stdin.removeListener('data', skipHandler);
      process.stdout.write('\r\x1b[2K'); // clear countdown line

      if (skipped) {
        console.log(`  ${fmt(C.dim, `Skipped. Run: npm install -g 0agent@${latest}`)}`);
        rl.prompt(true);
        return;
      }

      // Auto-install
      console.log(`  ${fmt(C.cyan, '↑')} Updating to ${latest}...`);
      const { execSync: exs } = await import('node:child_process');
      exs('npm install -g 0agent@latest --silent', { stdio: 'ignore', timeout: 120_000 });
      process.stdout.write(`  ${fmt(C.green, '✓')} Updated to ${latest} — restarting...\n\n`);

      await restartWithLatest();
    } catch {
      // Non-fatal — update failure never crashes the agent
    }
  })();

  rl.prompt();
})();

// Restart using the GLOBAL install, not the npx cache that's currently running.
// After `npm install -g 0agent@latest`, use `npm root -g` to find the module root.
// `npm bin -g` is deprecated and unreliable — use the module root instead.
async function restartWithLatest() {
  try {
    const { execSync: ex } = await import('node:child_process');
    const { resolve: res } = await import('node:path');
    const { existsSync: ef } = await import('node:fs');
    const { spawn: sp } = await import('node:child_process');

    // npm root -g → e.g. /Users/sahil/.nvm/versions/node/v20/lib/node_modules
    // The 0agent entry is at {root}/0agent/bin/0agent.js
    let newBin = null;
    try {
      const npmRoot = ex('npm root -g 2>/dev/null', { encoding: 'utf8' }).trim().split('\n')[0];
      if (npmRoot) {
        const candidate = res(npmRoot, '0agent', 'bin', '0agent.js');
        if (ef(candidate)) newBin = candidate;
      }
    } catch {}

    if (!newBin) {
      // Fallback: npm prefix -g gives the prefix, bin is {prefix}/bin/0agent
      try {
        const prefix = ex('npm prefix -g 2>/dev/null', { encoding: 'utf8' }).trim().split('\n')[0];
        // The script wrapper lives in {prefix}/bin; the actual JS is in lib/node_modules
        const candidate = prefix ? res(prefix, 'lib', 'node_modules', '0agent', 'bin', '0agent.js') : null;
        if (candidate && ef(candidate)) newBin = candidate;
      } catch {}
    }

    if (!newBin) {
      // Cannot locate the new binary — exit so user restarts manually
      process.stdout.write(`  ${fmt(C.dim, 'Restart manually: 0agent')}\n`);
      process.exit(0);
      return;
    }

    const child = sp(process.execPath, [newBin], { stdio: 'inherit' });
    child.on('close', (code) => process.exit(code ?? 0));
    process.stdin.pause();
  } catch {
    process.exit(0);
  }
}

function isNewerVersion(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false;
  }
  return false;
}


// ─── Message queue + serial executor ─────────────────────────────────────────

// Only these exact prefixes are built-in commands handled by handleCommand().
// Everything else starting with '/' is a skill → routed to runTask().
const COMMAND_PREFIXES = ['/model','/key','/status','/skills','/graph','/clear',
  '/help','/schedule','/update','/telegram'];

async function executeInput(line) {
  const isCmd = COMMAND_PREFIXES.some(c => line === c || line.startsWith(c + ' '));
  if (isCmd) {
    await handleCommand(line);
  } else {
    lastFailedTask = null;
    await runTask(line);
  }
  await drainQueue();
}

async function drainQueue() {
  if (messageQueue.length === 0) { if (!streaming) rl.prompt(); return; }
  const next = messageQueue.shift();
  if (messageQueue.length > 0) {
    console.log(`  ${fmt(C.dim, `[${messageQueue.length} more in queue]`)}`);
  }
  await executeInput(next);
}

rl.on('line', async (input) => {
  const line = input.trim();
  if (!line) { rl.prompt(); return; }

  // Bare `/` or partial `/cmd` with no session running → open interactive palette
  if (line.startsWith('/') && !pendingResolve) {
    const filter = line === '/' ? '' : line.slice(1);
    const exact  = SLASH_COMMANDS.find(c => c.cmd === line);
    if (!exact) {
      // Clear the echoed input line before opening palette
      process.stdout.write('\x1b[1A\r\x1b[2K');
      const selected = await openPalette(filter);
      if (selected) await executeInput(selected);
      else rl.prompt();
      return;
    }
  }

  // If a session is already running, queue the message.
  // pauseFor() stops the spinner briefly so the user can see the confirmation,
  // then resumes — prevents spinner from overwriting their typed text.
  if (pendingResolve) {
    messageQueue.push(line);
    const qLen = messageQueue.length;
    // No spinner.pauseFor() needed — session mode has no \r animation
    // Just print the queued confirmation and restore the › prompt
    process.stdout.write('\r\x1b[2K');
    process.stdout.write(
      `  ${fmt(C.magenta, '↳')} ${fmt(C.bold, `[queued #${qLen}]`)} ${fmt(C.dim, line.slice(0, 70))}\n`
    );
    if (qLen > 1) {
      process.stdout.write(`  ${fmt(C.dim, `${qLen} tasks waiting`)}\n`);
    }
    rl.prompt(true); // keep › visible
    return;
  }

  await executeInput(line);
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
