import type { SQLiteAdapter } from './adapters/SQLiteAdapter.js';
import type { WeightEvent } from './adapters/SQLiteAdapter.js';

export type { WeightEvent };

export class WeightEventLog {
  constructor(private adapter: SQLiteAdapter) {}

  append(event: WeightEvent): void {
    this.adapter.insertWeightEvent(event);
  }

  getByEdge(edgeId: string): WeightEvent[] {
    return this.adapter.getWeightEvents(edgeId);
  }

  getByTrace(traceId: string): WeightEvent[] {
    return this.adapter.getWeightEventsByTrace(traceId);
  }
}
