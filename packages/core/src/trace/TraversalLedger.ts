/**
 * TraversalLedger — 2-tier traversal logging for 0agent Phase 4.
 *
 * Records each edge traversal during plan execution, classifying edges
 * into two tiers based on competitive margin:
 *   - attribution_grade: edge weight dominates competitors by > 0.1
 *   - scan_only: edge was traversed but did not clearly dominate
 *
 * Converts to StepLedger[] for weight propagation.
 */

import type { GraphEdge } from '../graph/GraphEdge.js';
import type { StepLedger } from '../engine/WeightPropagation.js';

export interface TraversalEntry {
  edge_id: string;
  traversed_at: number;
  step_index: number;
  tier: 'scan_only' | 'attribution_grade';
  weight_at_traversal: number;
  competing_edge_weights: number[];
  has_sub_outcome: boolean;
}

export class TraversalLedger {
  private entries: TraversalEntry[] = [];

  record(edge: GraphEdge, stepIndex: number, siblings: GraphEdge[]): void {
    const competingWeights = siblings
      .filter(s => s.id !== edge.id)
      .map(s => s.weight);

    const bestCompetitor =
      competingWeights.length > 0 ? Math.max(...competingWeights) : 0;

    // attribution_grade if weight difference vs best competitor > 0.1
    const tier: TraversalEntry['tier'] =
      edge.weight - bestCompetitor > 0.1 ? 'attribution_grade' : 'scan_only';

    this.entries.push({
      edge_id: edge.id,
      traversed_at: Date.now(),
      step_index: stepIndex,
      tier,
      weight_at_traversal: edge.weight,
      competing_edge_weights: competingWeights,
      has_sub_outcome: false,
    });
  }

  markSubOutcome(edgeId: string): void {
    const entry = this.entries.find(e => e.edge_id === edgeId);
    if (entry) entry.has_sub_outcome = true;
  }

  getAll(): TraversalEntry[] {
    return [...this.entries];
  }

  getAttributionGrade(): TraversalEntry[] {
    return this.entries.filter(e => e.tier === 'attribution_grade');
  }

  getScanOnly(): TraversalEntry[] {
    return this.entries.filter(e => e.tier === 'scan_only');
  }

  toStepLedgers(): StepLedger[] {
    return this.entries.map(e => ({
      edge_id: e.edge_id,
      step_index: e.step_index,
      has_sub_outcome: e.has_sub_outcome,
      weight_at_traversal: e.weight_at_traversal,
    }));
  }

  toJSON(): TraversalEntry[] {
    return this.entries;
  }

  static fromJSON(entries: TraversalEntry[]): TraversalLedger {
    const ledger = new TraversalLedger();
    ledger.entries = entries;
    return ledger;
  }
}
