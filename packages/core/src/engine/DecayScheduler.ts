import type { KnowledgeGraph } from '../graph/KnowledgeGraph.js';
import type { GraphEdge } from '../graph/GraphEdge.js';
import type { EdgeWeightUpdater } from '../concurrency/EdgeWeightUpdater.js';

export interface DecayConfig {
  interval_ms: number;        // default: 6 hours (21_600_000)
  max_deferral_ms: number;    // default: 24 hours (86_400_000)
  grace_period_ms: number;    // default: 48 hours (172_800_000)
  max_delta_per_cycle: number; // default: 0.05
}

export interface DecayReport {
  edges_processed: number;
  edges_decayed: number;
  edges_skipped_locked: number;
  edges_skipped_grace: number;
  edges_skipped_neutral: number;
}

export class DecayScheduler {
  private config: DecayConfig;
  private lastRun: number = 0;
  private deferredSince: number | null = null;

  constructor(
    private graph: KnowledgeGraph,
    private updater: EdgeWeightUpdater,
    config?: Partial<DecayConfig>
  ) {
    this.config = {
      interval_ms: config?.interval_ms ?? 6 * 60 * 60 * 1000,
      max_deferral_ms: config?.max_deferral_ms ?? 24 * 60 * 60 * 1000,
      grace_period_ms: config?.grace_period_ms ?? 48 * 60 * 60 * 1000,
      max_delta_per_cycle: config?.max_delta_per_cycle ?? 0.05,
    };
  }

  /**
   * Compute decay for a single edge.
   * Returns new weight or null if no decay needed.
   *
   * Rules:
   * - Locked edges: skip (return null)
   * - Weight exactly 0.5: skip (already neutral)
   * - Within grace period (48h since last_traversed): skip
   * - Delta = min(decay_rate * |weight - 0.5| * hours_elapsed, max_delta)
   * - Direction: toward 0.5 (positive if below, negative if above)
   * - NEVER cross 0.5 in a single step (clamp)
   */
  decayEdge(edge: GraphEdge, now: number): number | null {
    if (edge.locked) return null;
    if (edge.weight === 0.5) return null;

    const lastTraversed = edge.last_traversed ?? edge.created_at;
    const age = now - lastTraversed;
    if (age < this.config.grace_period_ms) return null;

    const hoursElapsed = age / (60 * 60 * 1000);
    const distanceFromNeutral = Math.abs(edge.weight - 0.5);
    const rawDelta = edge.decay_rate * distanceFromNeutral * hoursElapsed;
    const cappedDelta = Math.min(rawDelta, this.config.max_delta_per_cycle);

    const direction = edge.weight > 0.5 ? -1 : 1;
    const newWeight = edge.weight + direction * cappedDelta;

    // Clamp: never cross 0.5
    if (direction > 0) {
      return Math.min(newWeight, 0.5);
    } else {
      return Math.max(newWeight, 0.5);
    }
  }

  /**
   * Run a full decay cycle over all edges.
   * Can be deferred if active sessions exist, but max 24h deferral.
   */
  async runCycle(now: number = Date.now(), canDefer: boolean = false): Promise<DecayReport> {
    const emptyReport: DecayReport = {
      edges_processed: 0,
      edges_decayed: 0,
      edges_skipped_locked: 0,
      edges_skipped_grace: 0,
      edges_skipped_neutral: 0,
    };

    // Check if we should defer
    if (canDefer && this.deferredSince === null) {
      this.deferredSince = now;
      return emptyReport;
    }

    // Force run if deferred too long
    if (this.deferredSince && (now - this.deferredSince) > this.config.max_deferral_ms) {
      canDefer = false;
    }

    if (canDefer) {
      return emptyReport;
    }

    const report: DecayReport = {
      edges_processed: 0,
      edges_decayed: 0,
      edges_skipped_locked: 0,
      edges_skipped_grace: 0,
      edges_skipped_neutral: 0,
    };

    const edges = this.graph.getAllEdges();
    for (const edge of edges) {
      report.edges_processed++;

      if (edge.locked) {
        report.edges_skipped_locked++;
        continue;
      }
      if (edge.weight === 0.5) {
        report.edges_skipped_neutral++;
        continue;
      }

      const newWeight = this.decayEdge(edge, now);
      if (newWeight === null) {
        report.edges_skipped_grace++;
        continue;
      }
      if (newWeight !== edge.weight) {
        await this.updater.update(edge.id, edge.weight, newWeight, 'time_decay');
        report.edges_decayed++;
      }
    }

    this.lastRun = now;
    this.deferredSince = null;
    return report;
  }

  shouldRun(now: number = Date.now()): boolean {
    return (now - this.lastRun) >= this.config.interval_ms;
  }

  getLastRun(): number {
    return this.lastRun;
  }
}
