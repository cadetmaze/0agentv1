/**
 * WebSocketEventBus — Phase 2 event bus with WebSocket broadcast.
 *
 * Broadcasts daemon events to connected WebSocket clients and local handlers.
 */

import type { WebSocket } from 'ws';

// ─── Event Types ─────────────────────────────────────

export type DaemonEvent =
  | { type: 'session.started'; session_id: string; task: string }
  | { type: 'session.step'; session_id: string; step: string; result: unknown }
  | { type: 'session.completed'; session_id: string; result: unknown }
  | { type: 'session.failed'; session_id: string; error: string }
  | { type: 'skill.started'; session_id: string; skill_name: string }
  | { type: 'skill.completed'; session_id: string; skill_name: string; duration_ms: number }
  | { type: 'skill.failed'; session_id: string; skill_name: string; error: string }
  | { type: 'subagent.spawned'; subagent_id: string; tools: string[] }
  | { type: 'subagent.completed'; subagent_id: string; duration_ms: number }
  | { type: 'graph.weight_updated'; edge_id: string; old_weight: number; new_weight: number }
  | { type: 'daemon.stats'; graph_nodes: number; active_sessions: number };

export type EventHandler = (event: DaemonEvent) => void;

export interface IEventBus {
  emit(event: Record<string, unknown>): void;
}

// ─── WebSocketEventBus ───────────────────────────────

export class WebSocketEventBus implements IEventBus {
  private clients: Set<WebSocket> = new Set();
  private handlers: Set<EventHandler> = new Set();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Register a connected WebSocket client.
   * Automatically removes on close.
   */
  addClient(ws: WebSocket): void {
    this.clients.add(ws);
    ws.on('close', () => {
      this.clients.delete(ws);
    });
    ws.on('error', () => {
      this.clients.delete(ws);
    });
  }

  /**
   * Manually remove a WebSocket client.
   */
  removeClient(ws: WebSocket): void {
    this.clients.delete(ws);
  }

  /**
   * Emit an event to all local handlers and broadcast to WS clients.
   */
  emit(event: Record<string, unknown>): void {
    const typed = event as unknown as DaemonEvent;

    // Notify local handlers
    for (const handler of this.handlers) {
      try {
        handler(typed);
      } catch {
        // Handler errors are non-fatal
      }
    }

    // Broadcast to WebSocket clients
    this.broadcast(typed);
  }

  /**
   * Register a local event handler.
   * Returns an unsubscribe function.
   */
  onEvent(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /**
   * Send an event to all connected WebSocket clients.
   */
  broadcast(event: DaemonEvent): void {
    if (this.clients.size === 0) return;

    const data = JSON.stringify(event);
    for (const ws of this.clients) {
      try {
        ws.send(data);
      } catch {
        // Send failure is non-fatal; client may have disconnected
        this.clients.delete(ws);
      }
    }
  }

  /**
   * Start a periodic heartbeat that emits daemon.stats events.
   * Runs every 30 seconds.
   */
  startStatsHeartbeat(
    getStats: () => { graph_nodes: number; active_sessions: number },
  ): void {
    this.stopStatsHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      const stats = getStats();
      this.emit({
        type: 'daemon.stats',
        graph_nodes: stats.graph_nodes,
        active_sessions: stats.active_sessions,
      });
    }, 30_000);
  }

  /**
   * Stop the stats heartbeat.
   */
  stopStatsHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Get the number of connected WS clients.
   */
  clientCount(): number {
    return this.clients.size;
  }

  /**
   * Get the number of registered local handlers.
   */
  handlerCount(): number {
    return this.handlers.size;
  }
}
