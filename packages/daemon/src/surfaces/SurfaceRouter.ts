/**
 * SurfaceRouter — central hub for all surface adapters.
 *
 * - Registers adapters by surface type
 * - Receives InboundMessages from any adapter
 * - Maps surface users to knowledge-graph entities
 * - Creates sessions and subscribes to their events
 * - Routes OutboundMessages back through the correct adapter
 *
 * Streaming: for surfaces that support it (Telegram, Slack), the router
 * accumulates session.token events and edits a "working…" message every ~400ms.
 */

import type { SessionManager } from '../SessionManager.js';
import type { IEventBus } from '../WebSocketEvents.js';
import type { KnowledgeGraph } from '@0agent/core';
import type { SurfaceAdapter, InboundMessage, OutboundMessage, SurfaceType } from './SurfaceAdapter.js';
import { UserEntityMapper } from './UserEntityMapper.js';

interface ActiveSession {
  sessionId: string;
  surface: SurfaceType;
  channelId: string;
  threadId?: string;
  /** Accumulated token buffer for streaming */
  tokenBuffer: string;
  /** Timer for debounced streaming edits */
  streamTimer: ReturnType<typeof setTimeout> | null;
}

export class SurfaceRouter {
  private adapters = new Map<SurfaceType, SurfaceAdapter>();
  private activeSessions = new Map<string, ActiveSession>(); // sessionId → state
  private userMapper: UserEntityMapper;
  private unsubscribeEvents: (() => void) | null = null;

  constructor(
    private sessions: SessionManager,
    private eventBus: IEventBus,
    private graph: KnowledgeGraph,
  ) {
    this.userMapper = new UserEntityMapper(graph);
  }

  /** Register a surface adapter. Call before start(). */
  register(adapter: SurfaceAdapter): void {
    this.adapters.set(adapter.name, adapter);
    adapter.onMessage((msg) => this._handleInbound(msg));
  }

  async start(): Promise<void> {
    // Subscribe to session events
    this.unsubscribeEvents = this.eventBus.onEvent((event) => {
      this._handleDaemonEvent(event as Record<string, unknown>);
    });

    // Start all registered adapters
    await Promise.allSettled(
      Array.from(this.adapters.values()).map((a) =>
        a.start().catch((err) => {
          console.error(`[surfaces] Failed to start ${a.name}:`, err instanceof Error ? err.message : err);
        }),
      ),
    );
  }

  async stop(): Promise<void> {
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = null;

    await Promise.allSettled(
      Array.from(this.adapters.values()).map((a) =>
        a.stop().catch(() => {}),
      ),
    );
  }

  private async _handleInbound(msg: InboundMessage): Promise<void> {
    const adapter = this.adapters.get(msg.surface);
    if (!adapter) return;

    // Map surface user to a graph entity
    const entityId = await this.userMapper.getOrCreate(
      msg.surface,
      msg.surface_user_id,
      msg.display_name,
    ).catch(() => undefined);

    // Build task text — include display name as context
    const userLabel = msg.display_name ?? msg.surface_user_id;
    const systemContext = `User: ${userLabel}. Surface: ${msg.surface}.`;
    const taskText = msg.text ?? '(no text)';

    const sessionReq = {
      task: taskText,
      context: {
        surface: msg.surface,
        system_context: systemContext,
        ...(entityId ? { entity_id: entityId } : {}),
        ...(msg.thread_id ? { thread_id: msg.thread_id } : {}),
        ...(msg.attachments?.length ? { attachments: JSON.stringify(msg.attachments) } : {}),
      },
    };

    try {
      const session = this.sessions.createSession(sessionReq);

      const sessionId = session.id;
      if (!sessionId) {
        await adapter.send({
          surface_channel_id: msg.surface_channel_id,
          text: '⚠️ Could not start session',
          format: 'prose',
          thread_id: msg.thread_id,
        });
        return;
      }

      // Track active session BEFORE starting so events don't arrive before we register
      this.activeSessions.set(sessionId, {
        sessionId,
        surface: msg.surface,
        channelId: msg.surface_channel_id,
        threadId: msg.thread_id,
        tokenBuffer: '',
        streamTimer: null,
      });

      // runExistingSession does the full LLM execution + graph writes (non-blocking)
      this.sessions.runExistingSession(sessionId, sessionReq).catch(() => {});
    } catch (err) {
      await adapter.send({
        surface_channel_id: msg.surface_channel_id,
        text: `⚠️ Error: ${err instanceof Error ? err.message : String(err)}`,
        format: 'prose',
        thread_id: msg.thread_id,
      });
    }
  }

  private _handleDaemonEvent(event: Record<string, unknown>): void {
    const sessionId = String(event.session_id ?? '');
    const state = this.activeSessions.get(sessionId);
    if (!state) return;

    const adapter = this.adapters.get(state.surface);
    if (!adapter) return;

    if (event.type === 'session.token') {
      // Accumulate token and debounce streaming update
      state.tokenBuffer += String(event.token ?? '');
      if (state.streamTimer) clearTimeout(state.streamTimer);
      state.streamTimer = setTimeout(() => {
        if (!state.tokenBuffer) return;
        adapter.send({
          surface_channel_id: state.channelId,
          text: state.tokenBuffer,
          format: 'markdown',
          is_progress: true,
          thread_id: state.threadId,
        }).catch(() => {});
      }, 400);
    } else if (event.type === 'session.completed') {
      // Cancel any pending stream timer
      if (state.streamTimer) { clearTimeout(state.streamTimer); state.streamTimer = null; }

      const result = event.result as Record<string, unknown> | undefined;
      const output = String(result?.output ?? '').trim();

      if (output && output !== '(no output)') {
        adapter.send({
          surface_channel_id: state.channelId,
          text: output,
          format: 'markdown',
          is_progress: false,
          thread_id: state.threadId,
        }).catch(() => {});
      }

      this.activeSessions.delete(sessionId);
    } else if (event.type === 'session.failed') {
      if (state.streamTimer) { clearTimeout(state.streamTimer); state.streamTimer = null; }

      adapter.send({
        surface_channel_id: state.channelId,
        text: `⚠️ ${String(event.error ?? 'Task failed')}`,
        format: 'prose',
        thread_id: state.threadId,
      }).catch(() => {});

      this.activeSessions.delete(sessionId);
    }
  }

  getAdapter(surface: SurfaceType): SurfaceAdapter | undefined {
    return this.adapters.get(surface);
  }

  registeredSurfaces(): SurfaceType[] {
    return Array.from(this.adapters.keys());
  }
}
