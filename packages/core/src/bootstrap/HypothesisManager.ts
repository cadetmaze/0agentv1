import type { KnowledgeGraph } from '../graph/KnowledgeGraph.js';

export interface HypothesisRecord {
  node_id: string;
  created_at: number;
  expires_at: number;
  promoted: boolean; // became a real node
  demoted: boolean; // was proven wrong, removed
  outcome_count: number;
  positive_outcomes: number;
  negative_outcomes: number;
}

const HYPOTHESIS_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const PROMOTION_THRESHOLD = 0.7; // positive_rate >= 70% to promote
const DEMOTION_THRESHOLD = 0.3; // positive_rate < 30% to demote
const MIN_OUTCOMES_TO_JUDGE = 3;

export class HypothesisManager {
  private hypotheses: Map<string, HypothesisRecord> = new Map();

  constructor(private graph: KnowledgeGraph) {}

  /**
   * Register a new hypothesis node.
   */
  register(nodeId: string): HypothesisRecord {
    const now = Date.now();
    const record: HypothesisRecord = {
      node_id: nodeId,
      created_at: now,
      expires_at: now + HYPOTHESIS_TTL_MS,
      promoted: false,
      demoted: false,
      outcome_count: 0,
      positive_outcomes: 0,
      negative_outcomes: 0,
    };
    this.hypotheses.set(nodeId, record);
    return record;
  }

  /**
   * Record an outcome for a hypothesis.
   */
  recordOutcome(nodeId: string, positive: boolean): void {
    const h = this.hypotheses.get(nodeId);
    if (!h || h.promoted || h.demoted) return;
    h.outcome_count++;
    if (positive) h.positive_outcomes++;
    else h.negative_outcomes++;

    // Auto-promote/demote if enough outcomes
    if (h.outcome_count >= MIN_OUTCOMES_TO_JUDGE) {
      const rate = h.positive_outcomes / h.outcome_count;
      if (rate >= PROMOTION_THRESHOLD) {
        this.promote(nodeId);
      } else if (rate <= DEMOTION_THRESHOLD) {
        this.demote(nodeId);
      }
    }
  }

  /**
   * Promote: hypothesis becomes a real node (change type from HYPOTHESIS to its intended type).
   */
  promote(nodeId: string): void {
    const h = this.hypotheses.get(nodeId);
    if (!h || h.promoted || h.demoted) return;
    h.promoted = true;
    // The node's type was already set correctly during bootstrap.
    // "Promoting" means it's no longer subject to hypothesis TTL pruning.
  }

  /**
   * Demote: remove the hypothesis node and its edges from the graph.
   */
  demote(nodeId: string): void {
    const h = this.hypotheses.get(nodeId);
    if (!h || h.promoted || h.demoted) return;
    h.demoted = true;
    this.graph.deleteNode(nodeId);
  }

  /**
   * Prune expired hypotheses that haven't been promoted.
   * Returns number of hypotheses pruned.
   */
  pruneExpired(): number {
    const now = Date.now();
    let pruned = 0;
    for (const [_nodeId, h] of this.hypotheses) {
      if (!h.promoted && !h.demoted && now > h.expires_at) {
        this.demote(h.node_id);
        pruned++;
      }
    }
    return pruned;
  }

  /**
   * Get a hypothesis record.
   */
  get(nodeId: string): HypothesisRecord | null {
    return this.hypotheses.get(nodeId) ?? null;
  }

  /**
   * Check if a node is a hypothesis.
   */
  isHypothesis(nodeId: string): boolean {
    const h = this.hypotheses.get(nodeId);
    return h !== undefined && !h.promoted && !h.demoted;
  }

  /**
   * Get all active hypotheses.
   */
  getActive(): HypothesisRecord[] {
    return [...this.hypotheses.values()].filter(
      (h) => !h.promoted && !h.demoted,
    );
  }
}
