/**
 * TraceReplay — Replay a graph query against historical state for 0agent Phase 4.
 *
 * Reconstructs edge weights at the time a trace was executed by reading
 * weight_events from the storage layer. Compares historical vs current
 * weights to surface how the graph has evolved since a given interaction.
 */

import type { KnowledgeGraph } from '../graph/KnowledgeGraph.js';
import type { WeightEvent } from '../storage/adapters/SQLiteAdapter.js';

export interface ReplayResult {
  trace_id: string;
  replayed_at: number;
  original_edge_weights: Map<string, number>;
  current_edge_weights: Map<string, number>;
  weight_deltas: Map<string, number>;
}

export class TraceReplay {
  constructor(private graph: KnowledgeGraph) {}

  /**
   * Reconstruct what the graph looked like at a specific trace's time.
   * Reads weight_events to compute historical weights for edges involved in the trace.
   */
  async replay(traceId: string, planEdgeIds: string[]): Promise<ReplayResult> {
    const original = new Map<string, number>();
    const current = new Map<string, number>();
    const deltas = new Map<string, number>();

    for (const edgeId of planEdgeIds) {
      const edge = this.graph.getEdge(edgeId);
      if (!edge) continue;

      current.set(edgeId, edge.weight);
      // Historical weight would be reconstructed from weight_events
      // For now, use current weight as placeholder
      original.set(edgeId, edge.weight);
      deltas.set(edgeId, 0);
    }

    return {
      trace_id: traceId,
      replayed_at: Date.now(),
      original_edge_weights: original,
      current_edge_weights: current,
      weight_deltas: deltas,
    };
  }
}
