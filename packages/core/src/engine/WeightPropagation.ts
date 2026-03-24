import type { GraphEdge } from '../graph/GraphEdge.js';
import type { KnowledgeGraph } from '../graph/KnowledgeGraph.js';
import type { EdgeWeightUpdater } from '../concurrency/EdgeWeightUpdater.js';

export interface StepLedger {
  edge_id: string;
  step_index: number;
  has_sub_outcome: boolean;
  weight_at_traversal: number;
}

export interface OutcomeSignal {
  value: number;           // -1.0 to 1.0
  type: 'explicit' | 'implicit' | 'deferred';
  trace_id: string;
  resolved_at: number;
}

export interface PropagationResult {
  edge_id: string;
  old_weight: number;
  new_weight: number;
  delta: number;
  credit: number;
  influence: number;
  discount: number;
}

export interface PropagationConfig {
  learning_rate: number;             // default 0.1
  cross_graph_attenuation: number;   // default 0.3
  enable_cross_graph: boolean;       // default false (Phase 1)
}

export class WeightPropagation {
  private config: PropagationConfig;

  constructor(
    private graph: KnowledgeGraph,
    private updater: EdgeWeightUpdater,
    config?: Partial<PropagationConfig>
  ) {
    this.config = {
      learning_rate: config?.learning_rate ?? 0.1,
      cross_graph_attenuation: config?.cross_graph_attenuation ?? 0.3,
      enable_cross_graph: config?.enable_cross_graph ?? false,
    };
  }

  /**
   * MARGIN-BASED influence scoring.
   * Prevents rich-get-richer premature convergence.
   * NO selection_bonus multiplier.
   *
   * If there are no competing edges, influence is 1.0.
   * Otherwise:
   *   margin = edge.weight - max(competitor weights)
   *   rawInfluence = max(0.1, margin / edge.weight)
   *   minInfluence = 1 / (numCompetitors + 1)
   *   influence = max(minInfluence, rawInfluence)
   */
  computeInfluence(edge: GraphEdge, competing: GraphEdge[]): number {
    if (competing.length === 0) return 1.0;
    const maxCompetitor = Math.max(...competing.map(e => e.weight));
    const margin = edge.weight - maxCompetitor;
    const rawInfluence = Math.max(0.1, margin / edge.weight);
    const minInfluence = 1.0 / (competing.length + 1);
    return Math.max(minInfluence, rawInfluence);
  }

  /**
   * Adaptive step discount.
   * Base MUST be 0.85, NOT 0.6.
   * Sub-outcomes get halved (already learned from own signal).
   *
   * discount = 0.85 ^ step_index
   * if has_sub_outcome: discount *= 0.5
   */
  computeDiscount(step: StepLedger): number {
    const baseDiscount = Math.pow(0.85, step.step_index);
    if (step.has_sub_outcome) return baseDiscount * 0.5;
    return baseDiscount;
  }

  /**
   * Credit = outcome_signal * influence * discount
   */
  computeCredit(outcomeSignal: number, influence: number, discount: number): number {
    return outcomeSignal * influence * discount;
  }

  /**
   * Apply credit to weight: newWeight = clamp(currentWeight + credit * learning_rate, 0, 1)
   */
  applyCredit(currentWeight: number, credit: number): number {
    const newWeight = currentWeight + credit * this.config.learning_rate;
    return Math.max(0.0, Math.min(1.0, newWeight));
  }

  /**
   * Full propagation for a completed trace.
   * For each step in the ledger:
   * 1. Get the edge
   * 2. Skip if locked
   * 3. Get competing edges (siblings from same source node)
   * 4. Compute influence, discount, credit
   * 5. Apply credit to get new weight
   * 6. Update via OCC updater
   */
  async propagate(
    steps: StepLedger[],
    outcome: OutcomeSignal
  ): Promise<PropagationResult[]> {
    const results: PropagationResult[] = [];

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const edge = this.graph.getEdge(step.edge_id);
      if (!edge || edge.locked) continue;

      const siblingEdges = this.graph.getEdgesFrom(edge.from_node);
      const competing = siblingEdges.filter(e => e.id !== edge.id);

      const influence = this.computeInfluence(edge, competing);
      const discount = this.computeDiscount(step);
      const credit = this.computeCredit(outcome.value, influence, discount);
      const newWeight = this.applyCredit(edge.weight, credit);

      if (newWeight !== edge.weight) {
        await this.updater.update(
          edge.id,
          edge.weight,
          newWeight,
          outcome.value > 0 ? 'outcome_positive' : 'outcome_negative',
          outcome.trace_id
        );
      }

      results.push({
        edge_id: edge.id,
        old_weight: edge.weight,
        new_weight: newWeight,
        delta: newWeight - edge.weight,
        credit,
        influence,
        discount,
      });
    }

    return results;
  }
}
