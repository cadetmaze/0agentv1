/**
 * WhatsAppAdapter — WhatsApp surface for 0agent via Twilio or Meta Cloud API.
 *
 * This adapter does NOT start an HTTP server itself — it exports a Hono route
 * handler that should be mounted in HTTPServer. The `send()` method uses
 * the configured provider to deliver messages.
 *
 * Supported providers:
 *   twilio — Twilio WhatsApp sandbox / business. Inbound: HTTP POST form-encoded.
 *            Requires: account_sid, auth_token, from_number (whatsapp:+1...)
 *   meta   — Meta WhatsApp Cloud API. Inbound: HTTP POST JSON webhook.
 *            Requires: phone_number_id, access_token, verify_token
 *
 * WhatsApp rate limits:
 *   - Does NOT stream token-by-token (rate limited heavily).
 *   - Sends ONE "working…" message, then ONE final message.
 *   - 24-hour session window: can only reply to messages within 24h.
 *
 * Usage:
 *   Mount the webhook routes in HTTPServer:
 *     app.route('/webhooks', whatsappAdapter.webhookRoutes())
 */

import { Hono } from 'hono';
import type { SurfaceAdapter, InboundMessage, OutboundMessage } from './SurfaceAdapter.js';

export type WhatsAppProvider = 'twilio' | 'meta';

export interface WhatsAppAdapterConfig {
  provider: WhatsAppProvider;
  // Twilio
  account_sid?: string;
  auth_token?: string;
  from_number?: string; // e.g. "whatsapp:+14155238886"
  // Meta Cloud API
  phone_number_id?: string;
  access_token?: string;
  verify_token?: string;
  /** Daemon base URL. Default: http://localhost:4200 */
  daemon_url?: string;
}

export class WhatsAppAdapter implements SurfaceAdapter {
  readonly name = 'whatsapp' as const;

  private messageHandler: ((msg: InboundMessage) => Promise<void>) | null = null;
  private config: WhatsAppAdapterConfig;

  constructor(config: WhatsAppAdapterConfig) {
    this.config = config;
  }

  onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  async start(): Promise<void> {
    console.log(`[0agent] WhatsApp: adapter ready (${this.config.provider}). Mount /webhooks/whatsapp in HTTPServer.`);
  }

  async stop(): Promise<void> {}

  /**
   * Send a WhatsApp message to a recipient.
   * WhatsApp does not support streaming — only sends final or working messages.
   */
  async send(msg: OutboundMessage): Promise<void> {
    // Suppress streaming progress updates — only send final response
    if (msg.is_progress) return;

    const to = msg.surface_channel_id;
    const text = this._truncate(msg.text, 4096);

    if (this.config.provider === 'twilio') {
      await this._sendTwilio(to, text);
    } else {
      await this._sendMeta(to, text);
    }
  }

  /**
   * Returns a Hono router that handles inbound WhatsApp webhooks.
   * Mount this in HTTPServer: app.route('/webhooks', adapter.webhookRoutes())
   */
  webhookRoutes(): Hono {
    const router = new Hono();

    if (this.config.provider === 'twilio') {
      // Twilio sends form-encoded POST
      router.post('/whatsapp', async (c) => {
        try {
          const form = await c.req.formData();
          const body = form.get('Body') as string ?? '';
          const from = form.get('From') as string ?? ''; // "whatsapp:+1..."
          const profileName = form.get('ProfileName') as string ?? '';

          if (!body || !from) return c.text('OK');

          // Extract phone number from "whatsapp:+1234567890"
          const phoneNumber = from.replace('whatsapp:', '');

          if (this.messageHandler) {
            // Don't await — respond to Twilio immediately
            this.messageHandler({
              surface: 'whatsapp',
              surface_user_id: phoneNumber,
              surface_channel_id: phoneNumber,
              text: body,
              display_name: profileName || phoneNumber,
              raw: Object.fromEntries(form),
            }).catch(() => {});
          }

          // Twilio expects empty TwiML or TwiML response
          // We send async via REST API, so return empty TwiML
          c.header('Content-Type', 'application/xml');
          return c.body('<Response></Response>');
        } catch {
          return c.text('OK');
        }
      });
    } else {
      // Meta: webhook verification (GET) + inbound messages (POST)
      router.get('/whatsapp', (c) => {
        const mode = c.req.query('hub.mode');
        const token = c.req.query('hub.verify_token');
        const challenge = c.req.query('hub.challenge');

        if (mode === 'subscribe' && token === this.config.verify_token) {
          return c.text(challenge ?? '');
        }
        return c.text('Forbidden', 403);
      });

      router.post('/whatsapp', async (c) => {
        try {
          const body = await c.req.json() as Record<string, unknown>;
          const entry = (body['entry'] as Array<Record<string, unknown>>)?.[0];
          const change = (entry?.['changes'] as Array<Record<string, unknown>>)?.[0];
          const value = change?.['value'] as Record<string, unknown>;
          const messages = value?.['messages'] as Array<Record<string, unknown>>;

          if (!messages?.length) return c.json({ ok: true });

          for (const message of messages) {
            const from = String(message['from'] ?? '');
            const type = String(message['type'] ?? '');
            let text = '';

            if (type === 'text') {
              text = String((message['text'] as Record<string, unknown>)?.['body'] ?? '');
            } else if (type === 'audio' || type === 'voice') {
              // Audio messages — could transcribe via Whisper if media downloaded
              text = '[Voice message — transcription not yet available]';
            } else {
              continue; // Skip unsupported types
            }

            if (!from || !text) continue;

            if (this.messageHandler) {
              this.messageHandler({
                surface: 'whatsapp',
                surface_user_id: from,
                surface_channel_id: from,
                text,
                display_name: from,
                raw: message,
              }).catch(() => {});
            }
          }

          return c.json({ ok: true });
        } catch {
          return c.json({ ok: true });
        }
      });
    }

    return router;
  }

  // ── Twilio send ──────────────────────────────────────────────────────────

  private async _sendTwilio(to: string, text: string): Promise<void> {
    const { account_sid, auth_token, from_number } = this.config;
    if (!account_sid || !auth_token || !from_number) return;

    const toWhatsApp = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;

    const body = new URLSearchParams({
      From: from_number,
      To: toWhatsApp,
      Body: text,
    });

    await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${account_sid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + Buffer.from(`${account_sid}:${auth_token}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
        signal: AbortSignal.timeout(15_000),
      },
    ).catch((err) => {
      console.error('[WhatsApp] Twilio send failed:', err instanceof Error ? err.message : err);
    });
  }

  // ── Meta Cloud API send ──────────────────────────────────────────────────

  private async _sendMeta(to: string, text: string): Promise<void> {
    const { phone_number_id, access_token } = this.config;
    if (!phone_number_id || !access_token) return;

    await fetch(
      `https://graph.facebook.com/v19.0/${phone_number_id}/messages`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'text',
          text: { body: text, preview_url: false },
        }),
        signal: AbortSignal.timeout(15_000),
      },
    ).catch((err) => {
      console.error('[WhatsApp] Meta send failed:', err instanceof Error ? err.message : err);
    });
  }

  private _truncate(text: string, limit: number): string {
    if (text.length <= limit) return text;
    return text.slice(0, limit - 3) + '…';
  }

  static isConfigured(config: unknown): config is WhatsAppAdapterConfig {
    const c = config as Record<string, unknown> | undefined;
    if (!c?.provider) return false;
    if (c.provider === 'twilio') return !!(c.account_sid && c.auth_token && c.from_number);
    if (c.provider === 'meta') return !!(c.phone_number_id && c.access_token);
    return false;
  }
}
