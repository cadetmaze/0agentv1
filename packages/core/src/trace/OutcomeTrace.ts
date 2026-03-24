/**
 * OutcomeTrace — Immutable trace schema for 0agent Phase 4.
 *
 * Each OutcomeTrace captures the full lifecycle of a single agent
 * interaction: from input through entity extraction, context activation,
 * plan traversal, and final outcome signal with per-edge attribution.
 */

export interface OutcomeTrace {
  id: string;
  session_id: string;
  created_at: number;
  resolved_at?: number;
  input: string;
  extracted_entities: string[];
  activated_context: string[];
  plan_edges: string[];
  subagent_id?: string;
  subagent_task_type?: string;
  outcome_signal?: number;
  outcome_type?: 'explicit' | 'implicit' | 'deferred' | 'expired' | 'learning_signal';
  deferred: boolean;
  deferred_verifier?: string;
  attribution_results: AttributionResult[];
  llm_calls: number;
  tokens_used: number;
  duration_ms: number;
  metadata: Record<string, unknown>;
}

export interface AttributionResult {
  edge_id: string;
  tier: 'scan_only' | 'attribution_grade';
  credit: number;
  influence: number;
  discount: number;
  old_weight: number;
  new_weight: number;
}
