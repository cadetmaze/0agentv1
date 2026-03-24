import type { SQLiteAdapter, WeightEvent } from '../storage/adapters/SQLiteAdapter.js';
import type { WeightEventLog } from '../storage/WeightEventLog.js';

export class EdgeWeightUpdater {
  constructor(
    private adapter: SQLiteAdapter,
    private weightLog: WeightEventLog
  ) {}

  /**
   * Update edge weight with optimistic concurrency control.
   * Retries up to 3 times with exponential backoff (1ms, 2ms, 4ms).
   * On 3rd failure: LWW (last-write-wins) fallback.
   */
  async update(
    edgeId: string,
    expectedWeight: number,
    newWeight: number,
    reason: string,
    traceId?: string
  ): Promise<boolean> {
    const delays = [1, 2, 4];
    let currentExpected = expectedWeight;

    for (let attempt = 0; attempt <= 2; attempt++) {
      const success = this.adapter.updateEdgeWeight(edgeId, newWeight, currentExpected);
      if (success) {
        this.logEvent(edgeId, currentExpected, newWeight, reason, traceId);
        return true;
      }
      // Re-read current weight for next attempt
      const edge = this.adapter.getEdge(edgeId);
      if (!edge) return false;
      currentExpected = edge.weight;

      if (attempt < 2) {
        await this.sleep(delays[attempt]);
      }
    }

    // Emergency LWW fallback — all 3 OCC attempts failed
    console.warn(`OCC conflict on edge ${edgeId} after 3 retries — LWW fallback`);
    // NOTE: forceUpdateEdgeWeight must exist on SQLiteAdapter.
    // It executes: UPDATE edges SET weight = ? WHERE id = ?
    // without any OCC version/expected-weight check.
    this.adapter.forceUpdateEdgeWeight(edgeId, newWeight);
    this.logEvent(edgeId, currentExpected, newWeight, `${reason}:lww_fallback`, traceId);
    return true;
  }

  private logEvent(
    edgeId: string,
    oldWeight: number,
    newWeight: number,
    reason: string,
    traceId?: string
  ): void {
    const event: WeightEvent = {
      id: crypto.randomUUID(),
      edge_id: edgeId,
      old_weight: oldWeight,
      new_weight: newWeight,
      delta: newWeight - oldWeight,
      reason,
      trace_id: traceId ?? null,
      created_at: Date.now(),
    };
    this.weightLog.append(event);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
