/**
 * 0agent Telegram Gateway — multi-tenant bot.
 *
 * Each Telegram user gets their own Docker container running the 0agent daemon.
 * The container is created on first message and destroyed after IDLE_TIMEOUT.
 *
 * Required env vars:
 *   TELEGRAM_BOT_TOKEN   — from @BotFather
 *   ANTHROPIC_API_KEY    — (or OPENAI_API_KEY etc.)
 *   LLM_PROVIDER         — anthropic | openai | xai  (default: anthropic)
 *   LLM_MODEL            — e.g. claude-sonnet-4-6    (default: claude-sonnet-4-6)
 *
 * Optional:
 *   IDLE_TIMEOUT_MIN     — minutes before idle container is destroyed (default: 30)
 *   MAX_CONTAINERS       — max simultaneous users (default: 50)
 *   CONTAINER_MEMORY_MB  — RAM per container (default: 512)
 *   AGENT_IMAGE          — Docker image name (default: 0agent-sandbox)
 */

import TelegramBot from 'node-telegram-bot-api';
import Docker from 'dockerode';
import { WebSocket } from 'ws';

// ─── Config ───────────────────────────────────────────────────────────────────
const BOT_TOKEN        = process.env.TELEGRAM_BOT_TOKEN;
const API_KEY          = process.env.ANTHROPIC_API_KEY ?? process.env.OPENAI_API_KEY ?? process.env.XAI_API_KEY ?? '';
const LLM_PROVIDER     = process.env.LLM_PROVIDER  ?? 'anthropic';
const LLM_MODEL        = process.env.LLM_MODEL     ?? 'claude-sonnet-4-6';
const IDLE_TIMEOUT_MS  = (parseInt(process.env.IDLE_TIMEOUT_MIN ?? '30', 10)) * 60_000;
const MAX_CONTAINERS   = parseInt(process.env.MAX_CONTAINERS ?? '50', 10);
const CONTAINER_MEMORY = parseInt(process.env.CONTAINER_MEMORY_MB ?? '512', 10) * 1024 * 1024;
const AGENT_IMAGE      = process.env.AGENT_IMAGE ?? '0agent-sandbox';
const BASE_PORT        = 15000;
/** How often to edit the progress message with new tokens (ms) */
const STREAM_EDIT_INTERVAL_MS = 600;

if (!BOT_TOKEN) { console.error('TELEGRAM_BOT_TOKEN is required'); process.exit(1); }
if (!API_KEY)   { console.error('ANTHROPIC_API_KEY (or OPENAI_API_KEY) is required'); process.exit(1); }

// ─── State ────────────────────────────────────────────────────────────────────
const docker = new Docker();
const bot    = new TelegramBot(BOT_TOKEN, { polling: true });

/** chatId → { containerId, port, baseUrl, lastUsed, starting } */
const userContainers = new Map();
let   nextPort       = BASE_PORT;

/** chatId → { sessionId, workingMsgId, tokenBuffer, editTimer, ws } */
const activeTasks = new Map();

// ─── Container lifecycle ──────────────────────────────────────────────────────

async function getOrCreate(chatId) {
  if (userContainers.has(chatId)) {
    const c = userContainers.get(chatId);
    if (c.starting) await c.starting;
    c.lastUsed = Date.now();
    return c;
  }

  if (userContainers.size >= MAX_CONTAINERS) {
    throw new Error(`Server at capacity (${MAX_CONTAINERS} users). Try again later.`);
  }

  const port = nextPort++;

  const configYaml = [
    'llm_providers:',
    `  - provider: ${LLM_PROVIDER}`,
    `    model: ${LLM_MODEL}`,
    `    api_key: "${API_KEY}"`,
    '    is_default: true',
  ].join('\n');

  let resolveStarting;
  const startingPromise = new Promise(r => { resolveStarting = r; });
  userContainers.set(chatId, { starting: startingPromise, lastUsed: Date.now() });

  try {
    const container = await docker.createContainer({
      Image: AGENT_IMAGE,
      Env: [
        `ZEROAGENT_CONFIG=/root/.0agent/config.yaml`,
        `CONFIG_YAML=${configYaml}`,
      ],
      ExposedPorts: { '4200/tcp': {} },
      HostConfig: {
        PortBindings: { '4200/tcp': [{ HostPort: String(port) }] },
        Memory: CONTAINER_MEMORY,
        NanoCpus: 1_000_000_000,
        NetworkMode: 'bridge',
        SecurityOpt: ['no-new-privileges:true'],
        Tmpfs: { '/tmp': 'size=100m' },
      },
    });

    await container.start();

    const baseUrl = `http://localhost:${port}`;
    let ready = false;
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      try {
        const r = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1000) });
        if (r.ok) { ready = true; break; }
      } catch {}
    }
    if (!ready) throw new Error('Container daemon did not start in time');

    const info = { containerId: container.id, port, baseUrl, lastUsed: Date.now(), starting: null };
    userContainers.set(chatId, info);
    resolveStarting();
    console.log(`[gateway] Container started for chatId ${chatId} on port ${port}`);
    return info;

  } catch (err) {
    userContainers.delete(chatId);
    resolveStarting();
    throw err;
  }
}

async function destroyContainer(chatId) {
  const info = userContainers.get(chatId);
  if (!info || info.starting) return;
  userContainers.delete(chatId);
  // Clean up any active task
  const task = activeTasks.get(chatId);
  if (task) {
    task.ws?.close();
    clearTimeout(task.editTimer);
    activeTasks.delete(chatId);
  }
  try {
    const c = docker.getContainer(info.containerId);
    await c.stop({ t: 5 }).catch(() => {});
    await c.remove({ force: true }).catch(() => {});
    console.log(`[gateway] Container destroyed for chatId ${chatId}`);
  } catch {}
}

// ─── Task execution with streaming ───────────────────────────────────────────

async function runTaskStreaming(chatId, task, workingMsgId) {
  const { baseUrl, port } = await getOrCreate(chatId);

  // Create session
  const createRes = await fetch(`${baseUrl}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!createRes.ok) throw new Error(`Session create failed: ${createRes.status}`);
  const body = await createRes.json();
  const sessionId = body.session_id ?? body.id;
  if (!sessionId) throw new Error('No session ID returned');

  const taskState = { sessionId, workingMsgId, tokenBuffer: '', editTimer: null, ws: null };
  activeTasks.set(chatId, taskState);

  return new Promise((resolve, reject) => {
    // Connect via WebSocket for streaming events
    const wsUrl = `ws://localhost:${port}/api/ws`;
    let ws;
    try {
      ws = new WebSocket(wsUrl);
      taskState.ws = ws;
    } catch {
      // WebSocket not available — fall back to polling
      pollForCompletion(chatId, baseUrl, sessionId, workingMsgId, resolve, reject);
      return;
    }

    ws.on('open', () => {
      console.log(`[gateway] WS connected for chatId ${chatId} session ${sessionId}`);
    });

    ws.on('message', (data) => {
      try {
        const event = JSON.parse(data.toString());
        if (event.session_id !== sessionId) return;

        if (event.type === 'session.token') {
          taskState.tokenBuffer += event.token ?? '';
          scheduleStreamEdit(chatId, taskState, workingMsgId);
        } else if (event.type === 'session.step') {
          // Show step as part of working message
          const stepDesc = String(event.step ?? '');
          if (stepDesc && workingMsgId) {
            const preview = taskState.tokenBuffer
              ? `\n\n${truncate(taskState.tokenBuffer, 300)}`
              : '';
            editMessage(chatId, workingMsgId, `⚙️ ${stepDesc}${preview}`).catch(() => {});
          }
        } else if (event.type === 'session.completed') {
          finalizeTask(chatId, taskState, event, ws, resolve);
        } else if (event.type === 'session.failed') {
          ws.close();
          clearTimeout(taskState.editTimer);
          activeTasks.delete(chatId);
          reject(new Error(String(event.error ?? 'Task failed')));
        }
      } catch {}
    });

    ws.on('error', () => {
      // WS failed — fall back to polling
      pollForCompletion(chatId, baseUrl, sessionId, workingMsgId, resolve, reject);
    });

    ws.on('close', () => {
      // If task is still active after WS close, poll to get result
      if (activeTasks.has(chatId) && activeTasks.get(chatId).sessionId === sessionId) {
        pollForCompletion(chatId, baseUrl, sessionId, workingMsgId, resolve, reject);
      }
    });

    // Timeout safety: 5 minutes
    setTimeout(() => {
      if (activeTasks.has(chatId)) {
        ws.close();
        activeTasks.delete(chatId);
        reject(new Error('Task timed out after 5 minutes.'));
      }
    }, 5 * 60_000);
  });
}

function scheduleStreamEdit(chatId, taskState, workingMsgId) {
  if (taskState.editTimer) return; // already scheduled
  taskState.editTimer = setTimeout(() => {
    taskState.editTimer = null;
    if (!workingMsgId || !taskState.tokenBuffer) return;
    const preview = truncate(taskState.tokenBuffer, 3500);
    editMessage(chatId, workingMsgId, `⏳ ${preview}`).catch(() => {});
  }, STREAM_EDIT_INTERVAL_MS);
}

function finalizeTask(chatId, taskState, event, ws, resolve) {
  ws?.close();
  clearTimeout(taskState.editTimer);
  activeTasks.delete(chatId);

  const result = event.result ?? {};
  const output = String(result.output ?? '').trim() || '(done)';
  resolve({ ok: true, output, tokens: result.tokens_used });
}

async function pollForCompletion(chatId, baseUrl, sessionId, workingMsgId, resolve, reject) {
  for (let i = 0; i < 360; i++) {
    await sleep(500);
    try {
      const r = await fetch(`${baseUrl}/api/sessions/${sessionId}`, { signal: AbortSignal.timeout(3000) });
      const session = await r.json();

      // Update working message with step count
      if (workingMsgId && session.steps?.length) {
        const lastStep = session.steps[session.steps.length - 1];
        editMessage(chatId, workingMsgId, `⚙️ ${lastStep.description ?? 'Working…'}`).catch(() => {});
      }

      if (session.status === 'completed') {
        activeTasks.delete(chatId);
        return resolve({ ok: true, output: session.result?.output ?? '(done)', tokens: session.result?.tokens_used });
      }
      if (session.status === 'failed' || session.status === 'cancelled') {
        activeTasks.delete(chatId);
        return reject(new Error(session.error ?? 'Task failed'));
      }
    } catch {}
  }
  activeTasks.delete(chatId);
  reject(new Error('Task timed out after 3 minutes.'));
}

// ─── Telegram message helpers ─────────────────────────────────────────────────

async function editMessage(chatId, messageId, text) {
  const chunk = truncate(text, 4000);
  try {
    await bot.editMessageText(chunk, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
  } catch {
    // If markdown fails, try plain
    await bot.editMessageText(chunk, { chat_id: chatId, message_id: messageId }).catch(() => {});
  }
}

function sendChunked(chatId, text) {
  const chunks = splitMessage(text, 4000);
  return chunks.reduce((p, chunk) =>
    p.then(() => bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown' }).catch(() =>
      bot.sendMessage(chatId, chunk).catch(() => {})
    )),
    Promise.resolve()
  );
}

// ─── Telegram handlers ────────────────────────────────────────────────────────

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, [
    '👋 *Welcome to 0agent\\!*',
    '',
    "I'm an AI agent running on a private VM\\. Send me any task:",
    '• 🔍 Research and summarise topics',
    '• 💻 Write and run code',
    '• 📁 Create files, scripts, automation',
    '• 🌐 Browse and scrape websites',
    '',
    '*Commands:*',
    '/cancel — stop the current task',
    '/stop — destroy your VM',
    '/status — check VM status',
    '',
    'Just type what you need\\.',
  ].join('\n'), { parse_mode: 'MarkdownV2' });
});

bot.onText(/\/stop/, async (msg) => {
  const chatId = msg.chat.id;
  await destroyContainer(chatId);
  bot.sendMessage(chatId, '🛑 Your VM has been stopped. Send a new message to start fresh.');
});

bot.onText(/\/cancel/, async (msg) => {
  const chatId = msg.chat.id;
  const task = activeTasks.get(chatId);
  if (!task) {
    bot.sendMessage(chatId, 'No active task to cancel.');
    return;
  }
  const info = userContainers.get(chatId);
  if (info?.baseUrl) {
    try {
      await fetch(`${info.baseUrl}/api/sessions/${task.sessionId}/cancel`, {
        method: 'POST', signal: AbortSignal.timeout(3000),
      });
    } catch {}
  }
  task.ws?.close();
  clearTimeout(task.editTimer);
  activeTasks.delete(chatId);
  if (task.workingMsgId) {
    bot.editMessageText('🛑 Task cancelled.', { chat_id: chatId, message_id: task.workingMsgId }).catch(() => {});
  } else {
    bot.sendMessage(chatId, '🛑 Task cancelled.');
  }
});

bot.onText(/\/status/, (msg) => {
  const chatId = msg.chat.id;
  const info = userContainers.get(chatId);
  const task = activeTasks.get(chatId);
  if (!info || info.starting) {
    bot.sendMessage(chatId, '💤 No active VM. Send a task to start one.');
  } else {
    const idleMin = Math.round((Date.now() - info.lastUsed) / 60_000);
    const taskStatus = task ? `\n⚙️ Task running (session ${task.sessionId?.slice(0,8)}…)` : '';
    bot.sendMessage(chatId, `✅ VM running (idle ${idleMin}m, auto-stops at ${Math.round(IDLE_TIMEOUT_MS / 60_000)}m)${taskStatus}`);
  }
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text   = msg.text?.trim();

  if (!text || text.startsWith('/')) return;

  // Don't queue a second task while one is active
  if (activeTasks.has(chatId)) {
    bot.sendMessage(chatId, '⚙️ I\'m still working on the previous task. Use /cancel to stop it first.');
    return;
  }

  bot.sendChatAction(chatId, 'typing');
  const typingInterval = setInterval(() => bot.sendChatAction(chatId, 'typing'), 4000);

  // Send working message immediately
  let workingMsgId;
  try {
    const m = await bot.sendMessage(chatId, '⏳ Working on it…');
    workingMsgId = m.message_id;
  } catch {}

  try {
    const result = await runTaskStreaming(chatId, text, workingMsgId);

    clearInterval(typingInterval);

    const icon   = result.ok ? '' : '❌';
    const tokens = result.tokens ? `\n\n_${result.tokens} tokens_` : '';
    const reply  = `${icon}${result.output}${tokens}`;

    if (workingMsgId) {
      // Replace working message with final result
      await editMessage(chatId, workingMsgId, reply);
    } else {
      await sendChunked(chatId, reply);
    }

  } catch (err) {
    clearInterval(typingInterval);
    const errText = `❌ ${err.message}`;
    if (workingMsgId) {
      editMessage(chatId, workingMsgId, errText).catch(() => bot.sendMessage(chatId, errText));
    } else {
      bot.sendMessage(chatId, errText);
    }
  }
});

bot.on('polling_error', (err) => console.error('[gateway] polling error:', err.message));

// ─── Idle container cleanup ───────────────────────────────────────────────────

setInterval(async () => {
  for (const [chatId, info] of userContainers) {
    if (info.starting) continue;
    if (activeTasks.has(chatId)) continue; // don't destroy containers with active tasks
    if (Date.now() - info.lastUsed > IDLE_TIMEOUT_MS) {
      console.log(`[gateway] Destroying idle container for chatId ${chatId}`);
      await destroyContainer(chatId);
    }
  }
}, 5 * 60_000);

// ─── Graceful shutdown ────────────────────────────────────────────────────────

async function shutdown() {
  console.log('[gateway] Shutting down — destroying all containers…');
  bot.stopPolling();
  await Promise.all([...userContainers.keys()].map(destroyContainer));
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function truncate(text, maxLen) {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '…';
}

function splitMessage(text, maxLen) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + maxLen));
    i += maxLen;
  }
  return chunks;
}

console.log(`[gateway] 0agent Telegram bot started (image: ${AGENT_IMAGE}, max users: ${MAX_CONTAINERS})`);
