import type { SQLiteAdapter } from './adapters/SQLiteAdapter.js';
import type { TraceRecord } from './adapters/SQLiteAdapter.js';

export type { TraceRecord };

export class TraceStore {
  constructor(private adapter: SQLiteAdapter) {}

  insert(trace: TraceRecord): void {
    this.adapter.insertTrace(trace);
  }

  get(id: string): TraceRecord | null {
    return this.adapter.getTrace(id);
  }

  updateOutcome(id: string, signal: number, type: string, resolvedAt: number): void {
    this.adapter.updateTraceOutcome(id, signal, type, resolvedAt);
  }

  query(opts: { session_id?: string; deferred?: boolean; limit?: number }): TraceRecord[] {
    return this.adapter.queryTraces(opts);
  }
}
