/**
 * TelegramAdapter — native Telegram surface for 0agent.
 *
 * Features over the legacy TelegramBridge:
 *  - Implements SurfaceAdapter interface (works with SurfaceRouter)
 *  - Streaming: edits a "working…" message as tokens arrive (via is_progress)
 *  - Voice messages: downloads OGG → transcribes via Whisper → forwards as text
 *  - /cancel — cancels the running session for this chat
 *  - File attachments forwarded to agent as attachment context
 *  - Graceful Markdown fallback (retries as plain text on parse errors)
 */

import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SurfaceAdapter, InboundMessage, OutboundMessage } from './SurfaceAdapter.js';

export interface TelegramAdapterConfig {
  token: string;
  allowed_users?: number[];
  /** Daemon base URL for /status checks. Defaults to http://localhost:4200 */
  daemon_url?: string;
  /** Whether to transcribe voice messages via Whisper (requires whisper CLI). Default: true */
  transcribe_voice?: boolean;
  /** Whisper model to use. Default: base */
  whisper_model?: string;
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

interface TgMessage {
  message_id: number;
  from?: { id: number; first_name?: string; username?: string };
  chat: { id: number; type: string };
  text?: string;
  voice?: { file_id: string; duration: number; mime_type?: string };
  audio?: { file_id: string; duration: number; mime_type?: string };
  document?: { file_id: string; file_name?: string; mime_type?: string };
  photo?: Array<{ file_id: string; width: number; height: number }>;
  caption?: string;
}

export class TelegramAdapter implements SurfaceAdapter {
  readonly name = 'telegram' as const;

  private token: string;
  private allowedUsers: Set<number>;
  private daemonUrl: string;
  private transcribeVoice: boolean;
  private whisperModel: string;
  private offset = 0;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private messageHandler: ((msg: InboundMessage) => Promise<void>) | null = null;

  // Per-chat streaming state: chatId → { working_msg_id, accumulated_text }
  private streamingState = new Map<number, { workingMsgId: number; accumulatedText: string }>();
  // Per-chat active session IDs (for /cancel)
  private activeSessions = new Map<number, string>();

  constructor(private config: TelegramAdapterConfig) {
    this.token = config.token;
    this.allowedUsers = new Set(config.allowed_users ?? []);
    this.daemonUrl = config.daemon_url ?? 'http://localhost:4200';
    this.transcribeVoice = config.transcribe_voice ?? true;
    this.whisperModel = config.whisper_model ?? 'base';
  }

  onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    console.log('[0agent] Telegram: adapter started');
    this._poll();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
  }

  /**
   * Send a message to a Telegram chat.
   * If is_progress=true, edits the existing "working…" message.
   * Otherwise sends a new message.
   */
  async send(msg: OutboundMessage): Promise<void> {
    const chatId = Number(msg.surface_channel_id);
    if (!chatId) return;

    const state = this.streamingState.get(chatId);

    if (msg.is_progress && state) {
      // Edit the working message with accumulated content
      state.accumulatedText = msg.text;
      await this._editMessage(chatId, state.workingMsgId, `⏳ ${this._truncate(msg.text, 3800)}`);
    } else {
      // Final reply — delete working message, send full response
      if (state) {
        // Replace working message with final response
        await this._editMessage(chatId, state.workingMsgId, msg.text);
        this.streamingState.delete(chatId);
      } else {
        // No working message — just send
        await this._sendMessage(chatId, msg.text);
      }
      this.activeSessions.delete(chatId);
    }
  }

  private async _poll(): Promise<void> {
    if (!this.running) return;
    try {
      const updates = await this._getUpdates();
      for (const u of updates) {
        await this._handleUpdate(u).catch(() => {});
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
    if (!msg?.from) return;

    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const userName = msg.from.first_name ?? msg.from.username ?? 'User';

    // Access control
    if (this.allowedUsers.size > 0 && !this.allowedUsers.has(userId)) {
      await this._sendMessage(chatId, '⛔ You are not authorised to use this agent.');
      return;
    }

    const text = msg.text ?? msg.caption ?? '';

    // ── Built-in commands ──────────────────────────────────────────────────
    if (text === '/start' || text === '/help') {
      await this._sendMessage(chatId,
        `👋 Hi ${userName}\\! I'm 0agent — your AI that runs on your machine\\.\n\n` +
        `Send me any task and I'll get it done\\.\n\n` +
        `*Commands:*\n` +
        `/cancel — stop the current task\n` +
        `/status — check daemon status\n\n` +
        `*Examples:*\n` +
        `• "make a website for my coffee shop"\n` +
        `• "research competitor pricing"\n` +
        `• "fix the bug in auth\\.ts"\n\n` +
        `I remember everything across sessions\\.`
      );
      return;
    }

    if (text === '/status') {
      try {
        const r = await fetch(`${this.daemonUrl}/api/health`, { signal: AbortSignal.timeout(2000) });
        const h = await r.json() as Record<string, unknown>;
        await this._sendMessage(chatId,
          `✅ Daemon running\nGraph: ${h.graph_nodes} nodes · ${h.graph_edges} edges\nSessions: ${h.active_sessions} active`
        );
      } catch {
        await this._sendMessage(chatId, '⚠️ Daemon not reachable');
      }
      return;
    }

    if (text === '/cancel') {
      const sessionId = this.activeSessions.get(chatId);
      if (sessionId) {
        try {
          await fetch(`${this.daemonUrl}/api/sessions/${sessionId}/cancel`, {
            method: 'POST',
            signal: AbortSignal.timeout(3000),
          });
          await this._sendMessage(chatId, '🛑 Task cancelled.');
        } catch {
          await this._sendMessage(chatId, '⚠️ Could not cancel task.');
        }
      } else {
        await this._sendMessage(chatId, 'No active task to cancel.');
      }
      return;
    }

    // ── Voice message → transcribe ─────────────────────────────────────────
    if (msg.voice || msg.audio) {
      const fileId = msg.voice?.file_id ?? msg.audio?.file_id;
      if (!fileId) return;

      if (this.transcribeVoice) {
        await this._sendChatAction(chatId, 'typing');
        const transcript = await this._transcribeVoice(fileId);
        if (!transcript) {
          await this._sendMessage(chatId, '⚠️ Could not transcribe voice message.');
          return;
        }
        await this._sendMessage(chatId, `🎤 _"${transcript}"_\n\n⏳ Working on it…`);
        await this._dispatchTask(chatId, userId, userName, transcript, msg);
      } else {
        await this._sendMessage(chatId, '🎤 Voice messages not enabled. Set transcribe_voice: true in config.');
      }
      return;
    }

    // ── Text message ──────────────────────────────────────────────────────
    if (!text) return;

    await this._sendChatAction(chatId, 'typing');
    // Send working indicator and capture its message ID
    const workingMsg = await this._sendMessageWithId(chatId, '⏳ Working on it…');
    if (workingMsg) {
      this.streamingState.set(chatId, { workingMsgId: workingMsg, accumulatedText: '' });
    }

    await this._dispatchTask(chatId, userId, userName, text, msg);
  }

  private async _dispatchTask(
    chatId: number,
    userId: number,
    userName: string,
    text: string,
    msg: TgMessage,
  ): Promise<void> {
    if (!this.messageHandler) return;

    const inbound: InboundMessage = {
      surface: 'telegram',
      surface_user_id: String(userId),
      surface_channel_id: String(chatId),
      text,
      display_name: userName,
      raw: msg,
    };

    // File attachment
    if (msg.document) {
      const url = await this._getFileUrl(msg.document.file_id);
      if (url) {
        inbound.attachments = [{
          type: 'file',
          data: url,
          filename: msg.document.file_name,
          mime_type: msg.document.mime_type,
        }];
      }
    }

    await this.messageHandler(inbound);
  }

  private async _transcribeVoice(fileId: string): Promise<string | null> {
    try {
      const fileUrl = await this._getFileUrl(fileId);
      if (!fileUrl) return null;

      // Download to temp file
      const tmpDir = join(tmpdir(), '0agent-voice');
      if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
      const tmpPath = join(tmpDir, `${fileId}.ogg`);
      const wavPath = join(tmpDir, `${fileId}.wav`);

      // Download the file
      const res = await fetch(fileUrl);
      if (!res.ok) return null;
      const buf = await res.arrayBuffer();
      const { writeFileSync } = await import('node:fs');
      writeFileSync(tmpPath, Buffer.from(buf));

      // Convert OGG to WAV via ffmpeg
      const { execSync } = await import('node:child_process');
      try {
        execSync(`ffmpeg -y -i "${tmpPath}" -ar 16000 -ac 1 "${wavPath}" 2>/dev/null`, { timeout: 30_000 });
      } catch {
        // If ffmpeg not available, try directly with whisper on OGG
        // Whisper supports OGG directly
      }

      const inputFile = existsSync(wavPath) ? wavPath : tmpPath;

      // Run Whisper
      const whisperOut = execSync(
        `whisper "${inputFile}" --model ${this.whisperModel} --output_format txt --output_dir "${tmpDir}" --fp16 False 2>/dev/null`,
        { timeout: 120_000, encoding: 'utf8' },
      );

      // Whisper writes <filename>.txt
      const txtPath = inputFile.replace(/\.(ogg|wav)$/, '.txt');
      if (existsSync(txtPath)) {
        const { readFileSync } = await import('node:fs');
        return readFileSync(txtPath, 'utf8').trim();
      }

      return whisperOut?.trim() || null;
    } catch {
      return null;
    }
  }

  private async _getFileUrl(fileId: string): Promise<string | null> {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${this.token}/getFile?file_id=${fileId}`,
        { signal: AbortSignal.timeout(5000) },
      );
      const data = await res.json() as { ok: boolean; result: { file_path?: string } };
      if (!data.ok || !data.result.file_path) return null;
      return `https://api.telegram.org/file/bot${this.token}/${data.result.file_path}`;
    } catch {
      return null;
    }
  }

  private async _sendMessage(chatId: number, text: string): Promise<void> {
    await this._sendMessageWithId(chatId, text);
  }

  private async _sendMessageWithId(chatId: number, text: string): Promise<number | null> {
    const chunks = this._splitMessage(text, 4000);
    let lastMsgId: number | null = null;

    for (const chunk of chunks) {
      const res = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: chunk,
          parse_mode: 'Markdown',
        }),
        signal: AbortSignal.timeout(10_000),
      }).catch(() => null);

      if (res?.ok) {
        const data = await res.json() as { ok: boolean; result?: { message_id: number } };
        if (data.ok && data.result) lastMsgId = data.result.message_id;
      } else {
        // Retry without markdown
        const r2 = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: chunk }),
          signal: AbortSignal.timeout(10_000),
        }).catch(() => null);
        if (r2?.ok) {
          const data = await r2.json() as { ok: boolean; result?: { message_id: number } };
          if (data.ok && data.result) lastMsgId = data.result.message_id;
        }
      }
    }

    return lastMsgId;
  }

  private async _editMessage(chatId: number, messageId: number, text: string): Promise<void> {
    const chunks = this._splitMessage(text, 4000);
    const chunk = chunks[0] ?? '';

    await fetch(`https://api.telegram.org/bot${this.token}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text: chunk,
        parse_mode: 'Markdown',
      }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {
      // If edit fails (e.g., message too old), ignore
    });
  }

  private async _sendChatAction(chatId: number, action: string): Promise<void> {
    await fetch(`https://api.telegram.org/bot${this.token}/sendChatAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
  }

  private _splitMessage(text: string, limit: number): string[] {
    if (text.length <= limit) return [text];
    const chunks: string[] = [];
    let i = 0;
    while (i < text.length) {
      chunks.push(text.slice(i, i + limit));
      i += limit;
    }
    return chunks;
  }

  private _truncate(text: string, limit: number): string {
    if (text.length <= limit) return text;
    return text.slice(0, limit) + '…';
  }

  static isConfigured(config: unknown): config is TelegramAdapterConfig {
    const c = config as Record<string, unknown> | undefined;
    return !!(c?.token && typeof c.token === 'string' && c.token.length > 10);
  }
}
