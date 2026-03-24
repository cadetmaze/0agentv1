import type { SQLiteAdapter } from '@0agent/core';

export interface SyncDelta {
  type: 'weight_event' | 'signal_node';
  payload: Record<string, unknown>;
}

export class TeamSync {
  private timers: NodeJS.Timeout[] = [];
  private running = false;

  constructor(
    private teamManager: import('./TeamManager.js').TeamManager,
    private adapter: SQLiteAdapter,
    private entityNodeId: string,
  ) {}

  start(): void {
    this.running = true;
    // Sync every 30 seconds
    const t = setInterval(() => this.syncAll().catch(console.error), 30_000);
    t.unref();
    this.timers.push(t);
    // Initial sync after 5s
    const init = setTimeout(() => this.syncAll().catch(console.error), 5_000);
    init.unref();
    this.timers.push(init);
  }

  stop(): void {
    this.running = false;
    this.timers.forEach(t => clearInterval(t));
    this.timers = [];
  }

  async syncAll(): Promise<void> {
    for (const membership of this.teamManager.getMemberships()) {
      if (!this.running) break;
      try {
        await this.syncTeam(membership);
      } catch (err) {
        console.error(`[TeamSync] Failed to sync team ${membership.team_name}:`, err instanceof Error ? err.message : err);
      }
    }
  }

  private async syncTeam(membership: import('./TeamManager.js').TeamMembership): Promise<void> {
    // 1. Push recent weight events to team server
    const recentEvents = this.getRecentWeightEvents(membership.last_synced_at);
    if (recentEvents.length > 0) {
      const deltas: SyncDelta[] = recentEvents.map(e => ({
        type: 'weight_event',
        payload: { edge_id: e.edge_id, old_weight: e.old_weight, new_weight: e.new_weight, reason: e.reason, created_at: e.created_at },
      }));

      await fetch(`${membership.server_url}/api/teams/${membership.team_id}/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ member_entity_id: this.entityNodeId, deltas }),
      });
    }

    // 2. Pull remote deltas and apply
    const pullRes = await fetch(
      `${membership.server_url}/api/teams/${membership.team_id}/pull?since=${membership.last_synced_at}&exclude_member=${this.entityNodeId}`
    );
    if (!pullRes.ok) return;

    const { deltas: remoteDeltás, latest_timestamp } = await pullRes.json() as {
      deltas: Array<{ type: string; payload: Record<string, unknown> }>;
      latest_timestamp: number;
    };

    // Apply remote weight events (use force-update — remote team learnings applied optimistically)
    for (const delta of remoteDeltás) {
      if (delta.type === 'weight_event') {
        const { edge_id, new_weight } = delta.payload;
        if (edge_id && new_weight !== undefined) {
          try {
            // Apply with slight attenuation (team signal is 70% of individual signal)
            const edge = this.adapter.getEdge(String(edge_id));
            if (edge && !edge.locked) {
              const blended = edge.weight * 0.7 + (new_weight as number) * 0.3;
              this.adapter.forceUpdateEdgeWeight(String(edge_id), blended);
            }
          } catch {}
        }
      }
    }

    if (latest_timestamp > membership.last_synced_at) {
      this.teamManager.updateLastSynced(membership.team_id, latest_timestamp);
    }
  }

  private getRecentWeightEvents(since: number): Array<{ edge_id: string; old_weight: number; new_weight: number; reason: string; created_at: number }> {
    const db = (this.adapter as unknown as { db: import('better-sqlite3').Database }).db;
    return db.prepare(
      `SELECT edge_id, old_weight, new_weight, reason, created_at FROM weight_events WHERE created_at > ? ORDER BY created_at LIMIT 200`
    ).all(since) as any[];
  }
}
