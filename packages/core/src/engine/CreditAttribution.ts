/**
 * CreditAttribution — 3-layer credit attribution with DAG for 0agent Phase 4.
 *
 * Layer 1: Tier separation (attribution_grade vs scan_only)
 * Layer 2: Per-edge credit computation via WeightPropagation
 * Layer 3: DAG backward pass with competing-edge penalty
 */

import type { KnowledgeGraph } from '../graph/KnowledgeGraph.js';
import type { WeightPropagation, OutcomeSignal, StepLedger } from './WeightPropagation.js';
import type { TraversalLedger, TraversalEntry } from '../trace/TraversalLedger.js';
import type { AttributionResult } from '../trace/OutcomeTrace.js';

// ─── Interfaces ────────────────────────────────────────────

export interface DAGNode {
  edge_id: string;
  parents: string[];
  children: string[];
  base_credit: number;
  final_credit: number;
}

export interface AttributionConfig {
  /** Penalty applied when competing edges exist at the same source node */
  competing_edge_penalty: number;
  /** Credit split factor when multiple ambiguous paths lead to same outcome */
  ambiguity_split: number;
  /** Minimum weight margin to qualify for attribution_grade tier */
  min_attribution_grade_delta: number;
}

const DEFAULT_CONFIG: AttributionConfig = {
  competing_edge_penalty: -0.3,
  ambiguity_split: 0.5,
  min_attribution_grade_delta: 0.1,
};

// ─── Class ─────────────────────────────────────────────────

export class CreditAttribution {
  private propagation: WeightPropagation;
  private config: AttributionConfig;

  constructor(
    propagation: WeightPropagation,
    config?: Partial<AttributionConfig>,
  ) {
    this.propagation = propagation;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Attribute credit for a completed trace across all traversed edges.
   */
  async attribute(
    ledger: TraversalLedger,
    outcome: OutcomeSignal,
    graph: KnowledgeGraph,
  ): Promise<AttributionResult[]> {
    const allEntries = ledger.getAll();
    if (allEntries.length === 0) return [];

    // ── Layer 1: Tier separation ───────────────────────────
    const attributionGrade = allEntries.filter(
      (e) => e.tier === 'attribution_grade',
    );
    const scanOnly = allEntries.filter((e) => e.tier === 'scan_only');

    // ── Layer 2: Per-edge credit computation ───────────────
    const results: AttributionResult[] = [];

    for (const entry of attributionGrade) {
      const result = this.computeEntryCredit(entry, outcome, graph);
      if (result) results.push(result);
    }

    // scan_only entries get zero credit but are still recorded
    for (const entry of scanOnly) {
      results.push({
        edge_id: entry.edge_id,
        tier: 'scan_only',
        credit: 0,
        influence: 0,
        discount: 0,
        old_weight: entry.weight_at_traversal,
        new_weight: entry.weight_at_traversal,
      });
    }

    // ── Layer 3: DAG backward pass ─────────────────────────
    const dagNodes = this.buildDAG(attributionGrade, graph);
    this.backwardPass(dagNodes, results);

    return results;
  }

  // ─── Private helpers ─────────────────────────────────────

  private computeEntryCredit(
    entry: TraversalEntry,
    outcome: OutcomeSignal,
    graph: KnowledgeGraph,
  ): AttributionResult | null {
    const edge = graph.getEdge(entry.edge_id);
    if (!edge) return null;

    // Get competing edges (siblings from same source node)
    const siblings = graph.getEdgesFrom(edge.from_node);
    const competing = siblings.filter((e) => e.id !== edge.id);

    const influence = this.propagation.computeInfluence(edge, competing);

    const stepLedger: StepLedger = {
      edge_id: entry.edge_id,
      step_index: entry.step_index,
      has_sub_outcome: entry.has_sub_outcome,
      weight_at_traversal: entry.weight_at_traversal,
    };
    const discount = this.propagation.computeDiscount(stepLedger);

    const credit = this.propagation.computeCredit(
      outcome.value,
      influence,
      discount,
    );

    return {
      edge_id: entry.edge_id,
      tier: 'attribution_grade',
      credit,
      influence,
      discount,
      old_weight: edge.weight,
      new_weight: edge.weight, // actual weight update happens in propagation
    };
  }

  /**
   * Build a DAG from attribution_grade entries based on step ordering
   * and edge connectivity in the graph.
   */
  private buildDAG(
    entries: TraversalEntry[],
    graph: KnowledgeGraph,
  ): Map<string, DAGNode> {
    const dagNodes = new Map<string, DAGNode>();

    // Sort by step_index to establish ordering
    const sorted = [...entries].sort(
      (a, b) => a.step_index - b.step_index,
    );

    // Create DAG nodes
    for (const entry of sorted) {
      dagNodes.set(entry.edge_id, {
        edge_id: entry.edge_id,
        parents: [],
        children: [],
        base_credit: 0,
        final_credit: 0,
      });
    }

    // Establish parent-child relationships based on graph connectivity
    const edgeIds = new Set(sorted.map((e) => e.edge_id));

    for (const entry of sorted) {
      const edge = graph.getEdge(entry.edge_id);
      if (!edge) continue;

      // Find edges in our set that feed into this edge's source node
      for (const otherEntry of sorted) {
        if (otherEntry.edge_id === entry.edge_id) continue;
        if (otherEntry.step_index >= entry.step_index) continue;

        const otherEdge = graph.getEdge(otherEntry.edge_id);
        if (!otherEdge) continue;

        // otherEdge leads to the source of this edge
        if (otherEdge.to_node === edge.from_node) {
          const dagNode = dagNodes.get(entry.edge_id)!;
          const parentNode = dagNodes.get(otherEntry.edge_id)!;
          if (!dagNode.parents.includes(otherEntry.edge_id)) {
            dagNode.parents.push(otherEntry.edge_id);
          }
          if (!parentNode.children.includes(entry.edge_id)) {
            parentNode.children.push(entry.edge_id);
          }
        }
      }
    }

    return dagNodes;
  }

  /**
   * Backward pass through DAG: adjust credit for ambiguous paths
   * and apply competing edge penalty.
   */
  private backwardPass(
    dagNodes: Map<string, DAGNode>,
    results: AttributionResult[],
  ): void {
    // Map results by edge_id for lookup
    const resultMap = new Map<string, AttributionResult>();
    for (const r of results) {
      resultMap.set(r.edge_id, r);
    }

    // Set base credits from computed results
    for (const [edgeId, dagNode] of dagNodes) {
      const result = resultMap.get(edgeId);
      if (result) {
        dagNode.base_credit = result.credit;
        dagNode.final_credit = result.credit;
      }
    }

    // Backward pass: process nodes from leaves to roots
    const processed = new Set<string>();
    const toProcess = [...dagNodes.keys()];

    // Process leaf nodes first (no children), then work backward
    while (toProcess.length > 0) {
      const nextBatch: string[] = [];

      for (const edgeId of toProcess) {
        const dagNode = dagNodes.get(edgeId)!;

        // Can process if all children are already processed
        const allChildrenDone = dagNode.children.every((c) =>
          processed.has(c),
        );

        if (allChildrenDone) {
          // Apply ambiguity split: if multiple parents feed into the same
          // child, split the child's credit among parents
          for (const childId of dagNode.children) {
            const childDag = dagNodes.get(childId);
            if (childDag && childDag.parents.length > 1) {
              // Multiple parents — apply ambiguity split
              dagNode.final_credit *= this.config.ambiguity_split;
            }
          }

          // Apply competing edge penalty if this node has siblings in the DAG
          // that share the same parent
          for (const parentId of dagNode.parents) {
            const parentDag = dagNodes.get(parentId);
            if (parentDag && parentDag.children.length > 1) {
              dagNode.final_credit += this.config.competing_edge_penalty;
            }
          }

          // Update the result
          const result = resultMap.get(edgeId);
          if (result) {
            result.credit = dagNode.final_credit;
          }

          processed.add(edgeId);
        } else {
          nextBatch.push(edgeId);
        }
      }

      // Safety: if no progress, break to avoid infinite loop
      if (nextBatch.length === toProcess.length) {
        break;
      }

      toProcess.length = 0;
      toProcess.push(...nextBatch);
    }
  }
}
