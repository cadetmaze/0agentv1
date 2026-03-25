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

// ─── Config ───────────────────────────────────────────────────────────────────
const BOT_TOKEN        = process.env.TELEGRAM_BOT_TOKEN;
const API_KEY          = process.env.ANTHROPIC_API_KEY ?? process.env.OPENAI_API_KEY ?? process.env.XAI_API_KEY ?? '';
const LLM_PROVIDER     = process.env.LLM_PROVIDER  ?? 'anthropic';
const LLM_MODEL        = process.env.LLM_MODEL     ?? 'claude-sonnet-4-6';
const IDLE_TIMEOUT_MS  = (parseInt(process.env.IDLE_TIMEOUT_MIN ?? '30', 10)) * 60_000;
const MAX_CONTAINERS   = parseInt(process.env.MAX_CONTAINERS ?? '50', 10);
const CONTAINER_MEMORY = parseInt(process.env.CONTAINER_MEMORY_MB ?? '512', 10) * 1024 * 1024;
const AGENT_IMAGE      = process.env.AGENT_IMAGE ?? '0agent-sandbox';
const BASE_PORT        = 15000; // allocate user ports from here up

if (!BOT_TOKEN) { console.error('TELEGRAM_BOT_TOKEN is required'); process.exit(1); }
if (!API_KEY)   { console.error('ANTHROPIC_API_KEY (or OPENAI_API_KEY) is required'); process.exit(1); }

// ─── State ────────────────────────────────────────────────────────────────────
const docker = new Docker();
const bot    = new TelegramBot(BOT_TOKEN, { polling: true });

/**
 * userContainers: chatId → { containerId, port, baseUrl, lastUsed, starting }
 */
const userContainers = new Map();
let   nextPort       = BASE_PORT;

// ─── Container lifecycle ──────────────────────────────────────────────────────

async function getOrCreate(chatId) {
  // Return existing container if healthy
  if (userContainers.has(chatId)) {
    const c = userContainers.get(chatId);
    if (c.starting) {
      // Another message came in while container was starting — wait for it
      await c.starting;
    }
    c.lastUsed = Date.now();
    return c;
  }

  if (userContainers.size >= MAX_CONTAINERS) {
    throw new Error(`Server at capacity (${MAX_CONTAINERS} users). Try again later.`);
  }

  const port = nextPort++;

  // Build the config.yaml that will be injected into the container
  const configYaml = [
    'llm_providers:',
    `  - provider: ${LLM_PROVIDER}`,
    `    model: ${LLM_MODEL}`,
    `    api_key: "${API_KEY}"`,
    '    is_default: true',
  ].join('\n');

  // Resolve starting promise so concurrent messages wait
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
        NanoCpus: 1_000_000_000, // 1 CPU
        NetworkMode: 'bridge',
        // Security: no new privileges, read-only root except /tmp and /root
        SecurityOpt: ['no-new-privileges:true'],
        Tmpfs: { '/tmp': 'size=100m' },
      },
    });

    await container.start();

    // Wait up to 15s for daemon to be ready
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
  try {
    const c = docker.getContainer(info.containerId);
    await c.stop({ t: 5 }).catch(() => {});
    await c.remove({ force: true }).catch(() => {});
    console.log(`[gateway] Container destroyed for chatId ${chatId}`);
  } catch {}
}

// ─── Task execution ───────────────────────────────────────────────────────────

async function runTask(chatId, task) {
  const { baseUrl } = await getOrCreate(chatId);

  // Create session
  const createRes = await fetch(`${baseUrl}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!createRes.ok) throw new Error(`Session create failed: ${createRes.status}`);
  const { session_id } = await createRes.json();

  // Poll for completion (max 3 minutes)
  for (let i = 0; i < 360; i++) {
    await sleep(500);
    const r = await fetch(`${baseUrl}/api/sessions/${session_id}`, { signal: AbortSignal.timeout(3000) });
    const session = await r.json();

    if (session.status === 'completed') {
      return { ok: true, output: session.result?.output ?? '(done)', tokens: session.result?.tokens_used };
    }
    if (session.status === 'failed' || session.status === 'cancelled') {
      return { ok: false, output: session.error ?? 'Task failed' };
    }
  }

  return { ok: false, output: 'Task timed out after 3 minutes.' };
}

// ─── Telegram handlers ────────────────────────────────────────────────────────

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, [
    '👋 *Welcome to 0agent!*',
    '',
    "I'm an AI agent running on a private VM. Send me any task:",
    '• 🔍 Research and summarise topics',
    '• 💻 Write and run code',
    '• 📁 Create files, scripts, automation',
    '• 🌐 Browse and scrape websites',
    '• 📊 Analyse data',
    '',
    'Just type what you need.',
  ].join('\n'), { parse_mode: 'Markdown' });
});

bot.onText(/\/stop/, async (msg) => {
  const chatId = msg.chat.id;
  await destroyContainer(chatId);
  bot.sendMessage(chatId, '🛑 Your VM has been stopped. Send a new message to start fresh.');
});

bot.onText(/\/status/, (msg) => {
  const chatId = msg.chat.id;
  const info = userContainers.get(chatId);
  if (!info || info.starting) {
    bot.sendMessage(chatId, '💤 No active VM. Send a task to start one.');
  } else {
    const idleMin = Math.round((Date.now() - info.lastUsed) / 60_000);
    bot.sendMessage(chatId, `✅ VM running (idle ${idleMin}m, auto-stops at ${Math.round(IDLE_TIMEOUT_MS / 60_000)}m)`);
  }
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text   = msg.text?.trim();

  if (!text || text.startsWith('/')) return;

  // Keep "typing..." indicator alive
  const typingInterval = setInterval(() => bot.sendChatAction(chatId, 'typing'), 4000);
  bot.sendChatAction(chatId, 'typing');

  // Send a "working" acknowledgement for long tasks
  let ackMsgId;
  const ackTimer = setTimeout(async () => {
    try {
      const m = await bot.sendMessage(chatId, '⚙️ Working on it…');
      ackMsgId = m.message_id;
    } catch {}
  }, 3000);

  try {
    const result = await runTask(chatId, text);

    clearInterval(typingInterval);
    clearTimeout(ackTimer);
    if (ackMsgId) bot.deleteMessage(chatId, ackMsgId).catch(() => {});

    const icon   = result.ok ? '✅' : '❌';
    const tokens = result.tokens ? `\n\n_${result.tokens} tokens_` : '';
    const reply  = `${icon} ${result.output}${tokens}`;

    // Telegram message limit is 4096 chars
    if (reply.length <= 4096) {
      bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });
    } else {
      // Split into chunks
      const chunks = splitMessage(reply, 4000);
      for (const chunk of chunks) {
        await bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown' });
        await sleep(300);
      }
    }

  } catch (err) {
    clearInterval(typingInterval);
    clearTimeout(ackTimer);
    if (ackMsgId) bot.deleteMessage(chatId, ackMsgId).catch(() => {});
    bot.sendMessage(chatId, `❌ ${err.message}`);
  }
});

bot.on('polling_error', (err) => console.error('[gateway] polling error:', err.message));

// ─── Idle container cleanup ───────────────────────────────────────────────────

setInterval(async () => {
  for (const [chatId, info] of userContainers) {
    if (info.starting) continue;
    if (Date.now() - info.lastUsed > IDLE_TIMEOUT_MS) {
      console.log(`[gateway] Destroying idle container for chatId ${chatId}`);
      await destroyContainer(chatId);
    }
  }
}, 5 * 60_000); // check every 5 minutes

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
