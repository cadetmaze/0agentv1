/**
 * SlackAdapter — Slack surface for 0agent via Bolt + Socket Mode.
 *
 * Socket Mode requires no public URL — works behind any firewall / NAT.
 * For cloud deployments, swap to HTTP mode in Bolt config.
 *
 * Features:
 *  - Responds to @mentions in channels and DMs
 *  - Thread-aware: always replies in-thread
 *  - Streaming: edits "working…" message as tokens arrive
 *  - /0agent slash command
 *  - File uploads forwarded to agent as attachments
 *
 * Required env or config:
 *   SLACK_BOT_TOKEN   xoxb-...
 *   SLACK_APP_TOKEN   xapp-...  (Socket Mode)
 *   SLACK_SIGNING_SECRET
 */

import type { SurfaceAdapter, InboundMessage, OutboundMessage } from './SurfaceAdapter.js';

export interface SlackAdapterConfig {
  bot_token: string;
  app_token: string;
  signing_secret: string;
}

export class SlackAdapter implements SurfaceAdapter {
  readonly name = 'slack' as const;

  private messageHandler: ((msg: InboundMessage) => Promise<void>) | null = null;
  private app: unknown = null; // @slack/bolt App instance
  // chatId:threadTs → { ts of working message }
  private streamingState = new Map<string, { ts: string; channelId: string; threadTs: string }>();

  constructor(private config: SlackAdapterConfig) {}

  onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  async start(): Promise<void> {
    let App: unknown;
    try {
      // @slack/bolt is an optional dependency
      const bolt = await import('@slack/bolt' as string);
      App = (bolt as Record<string, unknown>).App;
    } catch {
      console.warn('[0agent] Slack: @slack/bolt not installed. Run: npm install @slack/bolt');
      return;
    }

    const AppClass = App as new (config: Record<string, unknown>) => Record<string, unknown>;
    this.app = new AppClass({
      token: this.config.bot_token,
      appToken: this.config.app_token,
      signingSecret: this.config.signing_secret,
      socketMode: true,
      logLevel: 'error',
    });

    const app = this.app as Record<string, (...args: unknown[]) => unknown>;

    // ── App mention in channels ──
    app['event']('app_mention', async ({ event, say }: Record<string, unknown>) => {
      await this._handleSlackEvent(event as Record<string, unknown>, say as (...args: unknown[]) => Promise<unknown>);
    });

    // ── DMs ──
    app['message'](async ({ message, say }: Record<string, unknown>) => {
      const msg = message as Record<string, unknown>;
      if (msg['channel_type'] !== 'im') return;
      await this._handleSlackEvent(msg, say as (...args: unknown[]) => Promise<unknown>);
    });

    // ── Slash command: /0agent ──
    app['command']('/0agent', async ({ command, ack, say }: Record<string, unknown>) => {
      await (ack as () => Promise<void>)();
      const cmd = command as Record<string, unknown>;
      await this._handleSlackEvent({
        user: cmd['user_id'],
        channel: cmd['channel_id'],
        text: cmd['text'],
        ts: String(Date.now()),
        subtype: undefined,
      }, say as (...args: unknown[]) => Promise<unknown>);
    });

    // Start Socket Mode
    await (app['start'] as () => Promise<void>)();
    console.log('[0agent] Slack: adapter started (Socket Mode)');
  }

  async stop(): Promise<void> {
    if (this.app) {
      try {
        await ((this.app as Record<string, unknown>)['stop'] as () => Promise<void>)();
      } catch {}
    }
  }

  async send(msg: OutboundMessage): Promise<void> {
    if (!this.app) return;
    const client = (this.app as Record<string, unknown>)['client'] as Record<string, (...args: unknown[]) => Promise<unknown>>;

    const stateKey = `${msg.surface_channel_id}:${msg.thread_id ?? ''}`;
    const state = this.streamingState.get(stateKey);

    if (msg.is_progress && state) {
      // Edit existing "working…" message
      try {
        await client['chat.update']({
          channel: state.channelId,
          ts: state.ts,
          text: `⏳ ${this._truncate(msg.text, 3000)}`,
        });
      } catch {}
    } else {
      // Final message
      if (state) {
        // Replace the working message with final response
        try {
          await client['chat.update']({
            channel: state.channelId,
            ts: state.ts,
            text: msg.text,
            thread_ts: state.threadTs || undefined,
          });
        } catch {
          // If update fails, post new message
          await this._postMessage(client, msg.surface_channel_id, msg.text, msg.thread_id);
        }
        this.streamingState.delete(stateKey);
      } else {
        await this._postMessage(client, msg.surface_channel_id, msg.text, msg.thread_id);
      }
    }
  }

  private async _handleSlackEvent(
    event: Record<string, unknown>,
    say: (...args: unknown[]) => Promise<unknown>,
  ): Promise<void> {
    if (!this.messageHandler) return;
    if (event['subtype']) return; // Skip bot messages, edits, etc.

    const userId = String(event['user'] ?? '');
    const channelId = String(event['channel'] ?? '');
    const threadTs = String(event['thread_ts'] ?? event['ts'] ?? '');
    // Strip bot mention from text
    const rawText = String(event['text'] ?? '');
    const text = rawText.replace(/<@[A-Z0-9]+>/g, '').trim();

    if (!text) return;

    const stateKey = `${channelId}:${threadTs}`;

    // Post "working…" and capture its ts
    try {
      const client = (this.app as Record<string, unknown>)['client'] as Record<string, (...args: unknown[]) => Promise<unknown>>;
      const resp = await client['chat.postMessage']({
        channel: channelId,
        text: '⏳ Working on it…',
        thread_ts: threadTs,
      }) as Record<string, unknown>;

      if (resp['ok']) {
        this.streamingState.set(stateKey, {
          ts: String(resp['ts'] ?? ''),
          channelId,
          threadTs,
        });
      }
    } catch {}

    const inbound: InboundMessage = {
      surface: 'slack',
      surface_user_id: userId,
      surface_channel_id: channelId,
      text,
      thread_id: threadTs,
      display_name: userId, // Could resolve via users.info
      raw: event,
    };

    // Handle file uploads
    const files = event['files'] as Array<Record<string, unknown>> | undefined;
    if (files?.length) {
      inbound.attachments = files.map(f => ({
        type: 'file' as const,
        data: String(f['url_private'] ?? ''),
        filename: String(f['name'] ?? ''),
        mime_type: String(f['mimetype'] ?? ''),
      }));
    }

    await this.messageHandler(inbound);
  }

  private async _postMessage(
    client: Record<string, (...args: unknown[]) => Promise<unknown>>,
    channelId: string,
    text: string,
    threadTs?: string,
  ): Promise<void> {
    try {
      await client['chat.postMessage']({
        channel: channelId,
        text,
        thread_ts: threadTs,
        mrkdwn: true,
      });
    } catch {}
  }

  private _truncate(text: string, limit: number): string {
    if (text.length <= limit) return text;
    return text.slice(0, limit) + '…';
  }

  static isConfigured(config: unknown): config is SlackAdapterConfig {
    const c = config as Record<string, unknown> | undefined;
    return !!(c?.bot_token && c?.app_token && c?.signing_secret);
  }
}
