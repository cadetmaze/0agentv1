/**
 * DeferredTrace — Deferred trace store and /retro output types for 0agent Phase 4.
 *
 * Manages traces whose outcome signals are not yet available.
 * Each deferred entry has a verifier, TTL, and check interval.
 * Supports bulk resolution by verifier and automatic expiration.
 */

import type { OutcomeSignal } from '../engine/WeightPropagation.js';

export interface DeferredTraceEntry {
  trace_id: string;
  verifier: string;
  check_interval_ms: number;
  ttl_ms: number;
  created_at: number;
  last_checked_at?: number;
  resolved: boolean;
  resolved_signal?: number;
  resolved_type?: string;
}

/** Output shape for the /retro command. */
export interface RetroOutput {
  sprint_id: string;
  period: string;
  summary: string;
  steps: RetroStep[];
  lessons: string[];
}

export interface RetroStep {
  skill_name: string;
  signal: number;
  rationale: string;
  sprint_period: string;
}

export class DeferredTraceStore {
  private entries: Map<string, DeferredTraceEntry> = new Map();

  open(entry: DeferredTraceEntry): void {
    this.entries.set(entry.trace_id, entry);
  }

  resolve(traceId: string, signal: number, type: string): void {
    const e = this.entries.get(traceId);
    if (e) {
      e.resolved = true;
      e.resolved_signal = signal;
      e.resolved_type = type;
    }
  }

  expire(traceId: string): void {
    this.resolve(traceId, 0.0, 'expired');
  }

  bulkResolveByVerifier(verifier: string, signal: number): number {
    let count = 0;
    for (const e of this.entries.values()) {
      if (e.verifier === verifier && !e.resolved) {
        this.resolve(e.trace_id, signal, 'bulk');
        count++;
      }
    }
    return count;
  }

  getPending(): DeferredTraceEntry[] {
    return [...this.entries.values()].filter(e => !e.resolved);
  }

  getExpired(now: number): DeferredTraceEntry[] {
    return this.getPending().filter(e => now > e.created_at + e.ttl_ms);
  }

  get(traceId: string): DeferredTraceEntry | undefined {
    return this.entries.get(traceId);
  }
}
