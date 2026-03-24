/**
 * TelegramBridge — connects a Telegram bot to 0agent.
 *
 * Any message sent to the bot is forwarded to 0agent as a task.
 * The response streams back as Telegram messages.
 *
 * Config in ~/.0agent/config.yaml:
 *   telegram:
 *     token: "123456:ABC-..."
 *     allowed_users: []   # empty = allow all; set to [user_id, ...] to restrict
 */

import type { SessionManager } from './SessionManager.js';
import type { IEventBus } from './WebSocketEvents.js';

interface TelegramConfig {
  token: string;
  allowed_users?: number[];
}

interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; first_name?: string; username?: string };
    chat: { id: number; type: string };
    text?: string;
  };
}

export class TelegramBridge {
  private token: string;
  private allowedUsers: Set<number>;
  private offset = 0;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  // session_id per chat for streaming
  private pendingSessions = new Map<number, string>();

  constructor(
    private config: TelegramConfig,
    private sessions: SessionManager,
    private eventBus: IEventBus,
  ) {
    this.token = config.token;
    this.allowedUsers = new Set(config.allowed_users ?? []);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    console.log('[0agent] Telegram: bot polling started');
    this._poll();

    // Listen to session events to stream responses back to Telegram
    this.eventBus.onEvent((event: Record<string, unknown>) => {
      const chatId = this._getChatIdForSession(String(event.session_id ?? ''));
      if (!chatId) return;

      if (event.type === 'session.completed') {
        const result = event.result as Record<string, unknown> | undefined;
        const output = String(result?.output ?? '').trim();
        if (output && output !== '(no output)') {
          this._send(chatId, output).catch(() => {});
        }
        this.pendingSessions.delete(chatId);
      } else if (event.type === 'session.failed') {
        const err = String(event.error ?? 'Task failed');
        this._send(chatId, `⚠️ ${err}`).catch(() => {});
        this.pendingSessions.delete(chatId);
      }
    });
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
  }

  private _getChatIdForSession(sessionId: string): number | null {
    for (const [chatId, sid] of this.pendingSessions) {
      if (sid === sessionId) return chatId;
    }
    return null;
  }

  private async _poll(): Promise<void> {
    if (!this.running) return;
    try {
      const updates = await this._getUpdates();
      for (const u of updates) {
        await this._handleUpdate(u);
      }
    } catch {}
    if (this.running) {
      this.pollTimer = setTimeout(() => this._poll(), 1000);
    }
  }

  private async _getUpdates(): Promise<TgUpdate[]> {
    const res = await fetch(
      `https://api.telegram.org/bot${this.token}/getUpdates?offset=${this.offset}&timeout=10&limit=20`,
      { signal: AbortSignal.timeout(15_000) },
    );
    if (!res.ok) return [];
    const data = await res.json() as { ok: boolean; result: TgUpdate[] };
    if (!data.ok || !data.result.length) return [];
    this.offset = data.result[data.result.length - 1].update_id + 1;
    return data.result;
  }

  private async _handleUpdate(u: TgUpdate): Promise<void> {
    const msg = u.message;
    if (!msg?.text || !msg.from) return;

    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text.trim();
    const userName = msg.from.first_name ?? msg.from.username ?? 'User';

    // Access control
    if (this.allowedUsers.size > 0 && !this.allowedUsers.has(userId)) {
      await this._send(chatId, '⛔ You are not authorised to use this agent.');
      return;
    }

    // /start or /help — orientation
    if (text === '/start' || text === '/help') {
      await this._send(chatId,
        `👋 Hi ${userName}! I'm 0agent — your AI that runs on your machine.\n\n` +
        `Send me any task and I'll get it done:\n` +
        `• "make a website for my coffee shop"\n` +
        `• "research my competitor's pricing"\n` +
        `• "fix the bug in auth.ts"\n\n` +
        `I remember everything across sessions.`
      );
      return;
    }

    // /status
    if (text === '/status') {
      try {
        const r = await fetch('http://localhost:4200/api/health', { signal: AbortSignal.timeout(2000) });
        const h = await r.json() as Record<string, unknown>;
        await this._send(chatId,
          `✅ Daemon running\nGraph: ${h.graph_nodes} nodes · ${h.graph_edges} edges\nSessions: ${h.active_sessions} active`
        );
      } catch {
        await this._send(chatId, '⚠️ Daemon not reachable');
      }
      return;
    }

    // Any other message → run as a 0agent task
    // Show typing indicator
    await this._sendAction(chatId, 'typing');
    await this._send(chatId, `⏳ Working on it…`);

    try {
      const res = await fetch('http://localhost:4200/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task: text,
          context: { system_context: `User's name: ${userName}. Message from Telegram.` },
        }),
        signal: AbortSignal.timeout(5000),
      });
      const session = await res.json() as { session_id?: string; id?: string };
      const sessionId = session.session_id ?? session.id;
      if (sessionId) {
        this.pendingSessions.set(chatId, sessionId);
      } else {
        await this._send(chatId, '⚠️ Could not start session');
      }
    } catch (e) {
      await this._send(chatId, `⚠️ Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async _send(chatId: number, text: string): Promise<void> {
    // Split long messages (Telegram limit is 4096 chars)
    const chunks = this._splitMessage(text);
    for (const chunk of chunks) {
      await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: chunk, parse_mode: 'Markdown' }),
        signal: AbortSignal.timeout(10_000),
      }).catch(() => {
        // Retry without markdown if it fails (parse errors)
        return fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: chunk }),
          signal: AbortSignal.timeout(10_000),
        }).catch(() => {});
      });
    }
  }

  private async _sendAction(chatId: number, action: string): Promise<void> {
    await fetch(`https://api.telegram.org/bot${this.token}/sendChatAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
  }

  private _splitMessage(text: string): string[] {
    if (text.length <= 4000) return [text];
    const chunks: string[] = [];
    let i = 0;
    while (i < text.length) {
      chunks.push(text.slice(i, i + 4000));
      i += 4000;
    }
    return chunks;
  }

  static isConfigured(config: unknown): config is TelegramConfig {
    const c = config as Record<string, unknown> | undefined;
    return !!(c?.token && typeof c.token === 'string' && c.token.length > 10);
  }
}
