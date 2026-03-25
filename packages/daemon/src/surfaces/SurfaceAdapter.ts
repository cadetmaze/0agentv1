/**
 * SurfaceAdapter — unified interface for all message surface integrations.
 *
 * Each surface (Telegram, Slack, WhatsApp, Voice, Meeting) implements this
 * interface. The SurfaceRouter handles session creation and event routing.
 */

export type SurfaceType =
  | 'terminal'
  | 'slack'
  | 'api'
  | 'chat'
  | 'telegram'
  | 'whatsapp'
  | 'voice'
  | 'meeting';

export type FormatType = 'ansi' | 'markdown' | 'json' | 'prose';

export interface Attachment {
  type: 'image' | 'audio' | 'file' | 'video';
  /** Local file path or base64 data URI */
  data: string;
  mime_type?: string;
  filename?: string;
}

export interface InboundMessage {
  surface: SurfaceType;
  /** Stable user identifier on this surface (e.g. Telegram user ID, Slack user ID) */
  surface_user_id: string;
  /** Channel / chat / thread identifier */
  surface_channel_id: string;
  /** Transcribed or typed text */
  text?: string;
  attachments?: Attachment[];
  /** For Slack threads, Zoom meeting IDs, etc. */
  thread_id?: string;
  /** Display name of the user (best-effort) */
  display_name?: string;
  /** Original platform-specific payload */
  raw?: unknown;
}

export interface OutboundMessage {
  surface_channel_id: string;
  text: string;
  format: FormatType;
  /** If true, edit/replace an existing "working..." indicator */
  is_progress?: boolean;
  attachments?: Attachment[];
  thread_id?: string;
}

export interface SurfaceAdapter {
  readonly name: SurfaceType;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(msg: OutboundMessage): Promise<void>;
  onMessage(handler: (msg: InboundMessage) => Promise<void>): void;
}
