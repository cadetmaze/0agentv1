/**
 * BackgroundWorkers — Phase 2 background worker scheduler.
 *
 * Manages periodic background tasks: decay cycles, deferred trace resolution,
 * and stubs for future compaction and enrichment phases.
 */

import type {
  KnowledgeGraph,
  DecayScheduler,
  TraceStore,
} from '@0agent/core';

// ─── Types ───────────────────────────────────────────

export interface BackgroundWorkersConfig {
  decay_interval_ms: number;
  deferred_trace_interval_ms: number;
  compactor_interval_ms: number;
  enrichment_interval_ms: number;
}

export interface WorkerStatus {
  name: string;
  active: boolean;
  last_run_at: number | null;
}

// Forward-declared interface so BackgroundWorkers doesn't need to import the full
// ProactiveSurface / TeamSync classes at module load time. The actual objects are
// duck-typed — just start() / stop() is required.
export interface Startable { start(): void; stop(): void; }

export interface BackgroundWorkersDeps {
  graph?: KnowledgeGraph;
  decayScheduler?: DecayScheduler;
  traceStore?: TraceStore;
  config?: Partial<BackgroundWorkersConfig>;
  proactiveSurface?: Startable;  // Collab-2: ProactiveSurface instance
  teamSync?: Startable;           // Collab-3: TeamSync instance
}

const DEFAULT_CONFIG: BackgroundWorkersConfig = {
  decay_interval_ms: 6 * 60 * 60 * 1000,      // 6 hours
  deferred_trace_interval_ms: 60_000,           // 60 seconds
  compactor_interval_ms: 24 * 60 * 60 * 1000,  // 24 hours
  enrichment_interval_ms: 5 * 60 * 1000,        // 5 minutes
};

// ─── BackgroundWorkers ───────────────────────────────

export class BackgroundWorkers {
  private graph?: KnowledgeGraph;
  private decayScheduler?: DecayScheduler;
  private traceStore?: TraceStore;
  private config: BackgroundWorkersConfig;
  private proactiveSurface?: Startable;
  private teamSync?: Startable;

  private timers: Map<string, ReturnType<typeof setInterval>> = new Map();
  private lastRunTimes: Map<string, number> = new Map();
  private running = false;

  constructor(deps: BackgroundWorkersDeps = {}) {
    this.graph = deps.graph;
    this.decayScheduler = deps.decayScheduler;
    this.traceStore = deps.traceStore;
    this.config = { ...DEFAULT_CONFIG, ...deps.config };
    this.proactiveSurface = deps.proactiveSurface;
    this.teamSync = deps.teamSync;
  }

  /**
   * Start all background workers.
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    // Decay worker
    if (this.decayScheduler) {
      const timer = setInterval(async () => {
        try {
          await this.decayScheduler!.runCycle();
          this.lastRunTimes.set('decay', Date.now());
        } catch (err) {
          console.error('[BackgroundWorkers] Decay cycle failed:', err);
        }
      }, this.config.decay_interval_ms);
      this.timers.set('decay', timer);
    }

    // Deferred trace resolver
    if (this.traceStore) {
      const timer = setInterval(() => {
        try {
          this.resolveDeferredTraces();
          this.lastRunTimes.set('deferred_traces', Date.now());
        } catch (err) {
          console.error('[BackgroundWorkers] Deferred trace resolution failed:', err);
        }
      }, this.config.deferred_trace_interval_ms);
      this.timers.set('deferred_traces', timer);
    }

    // Compactor stub (Phase 5)
    {
      const timer = setInterval(() => {
        console.log('[BackgroundWorkers] compactor not yet implemented');
        this.lastRunTimes.set('compactor', Date.now());
      }, this.config.compactor_interval_ms);
      this.timers.set('compactor', timer);
    }

    // Enrichment stub (Phase 4)
    {
      const timer = setInterval(() => {
        this.lastRunTimes.set('enrichment', Date.now());
      }, this.config.enrichment_interval_ms);
      this.timers.set('enrichment', timer);
    }

    // Proactive surface (Collab-2) — watches git + test output for insights
    if (this.proactiveSurface) {
      this.proactiveSurface.start();
      this.lastRunTimes.set('proactive_surface', Date.now());
    }

    // Team sync (Collab-3) — syncs weight events with team server every 30s
    if (this.teamSync) {
      this.teamSync.start();
      this.lastRunTimes.set('team_sync', Date.now());
    }
  }

  /**
   * Stop all background workers and clear timers.
   */
  stop(): void {
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
    this.proactiveSurface?.stop();
    this.teamSync?.stop();
    this.running = false;
  }

  /**
   * Whether workers are currently running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get status of all registered workers.
   */
  getWorkerStatus(): WorkerStatus[] {
    const workerNames = ['decay', 'deferred_traces', 'compactor', 'enrichment', 'proactive_surface', 'team_sync'];
    return workerNames.map((name) => ({
      name,
      active: this.timers.has(name),
      last_run_at: this.lastRunTimes.get(name) ?? null,
    }));
  }

  // ─── Private ───────────────────────────────────────

  /**
   * Find expired deferred traces and resolve them with signal 0.0.
   */
  private resolveDeferredTraces(): void {
    if (!this.traceStore) return;

    const now = Date.now();
    const deferred = this.traceStore.query({ deferred: true, limit: 100 });

    for (const trace of deferred) {
      if (trace.deferred_until !== null && trace.deferred_until <= now) {
        this.traceStore.updateOutcome(trace.id, 0.0, 'timeout', now);
      }
    }
  }
}
