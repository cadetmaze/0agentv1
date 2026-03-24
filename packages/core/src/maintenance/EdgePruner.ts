import type { KnowledgeGraph } from '../graph/KnowledgeGraph.js';
import type { GraphEdge } from '../graph/GraphEdge.js';
import { NodeType } from '../graph/GraphNode.js';

export interface PruneConfig {
  weight_delta_threshold: number; // default 0.1
  idle_days: number;              // default 14
  dry_run: boolean;
}

export interface PruneResult {
  pruned_count: number;
  skipped_locked: number;
  skipped_hypothesis: number;
  skipped_skill: number;
  skipped_active: number;
  pruned_edge_ids: string[];
}

const DEFAULT_CONFIG: PruneConfig = {
  weight_delta_threshold: 0.1,
  idle_days: 14,
  dry_run: false,
};

export class EdgePruner {
  constructor(private graph: KnowledgeGraph) {}

  prune(config?: Partial<PruneConfig>): PruneResult {
    const cfg: PruneConfig = { ...DEFAULT_CONFIG, ...config };

    const result: PruneResult = {
      pruned_count: 0,
      skipped_locked: 0,
      skipped_hypothesis: 0,
      skipped_skill: 0,
      skipped_active: 0,
      pruned_edge_ids: [],
    };

    const idleThresholdMs = cfg.idle_days * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const edges: GraphEdge[] = this.graph.getAllEdges();

    for (const edge of edges) {
      // Skip if weight is not neutral enough (too far from 0.5)
      if (Math.abs(edge.weight - 0.5) >= cfg.weight_delta_threshold) {
        continue;
      }

      // Skip if edge was recently traversed (still active)
      const lastActivity = edge.last_traversed ?? edge.created_at;
      if (now - lastActivity < idleThresholdMs) {
        result.skipped_active++;
        continue;
      }

      // Skip if locked
      if (edge.locked) {
        result.skipped_locked++;
        continue;
      }

      // Skip if connected to a HYPOTHESIS node
      const fromNode = this.graph.getNode(edge.from_node);
      const toNode = this.graph.getNode(edge.to_node);

      if (
        (fromNode && fromNode.type === NodeType.HYPOTHESIS) ||
        (toNode && toNode.type === NodeType.HYPOTHESIS)
      ) {
        result.skipped_hypothesis++;
        continue;
      }

      // Skip if connected to a node with metadata.is_skill === true
      if (
        (fromNode && fromNode.metadata.is_skill === true) ||
        (toNode && toNode.metadata.is_skill === true)
      ) {
        result.skipped_skill++;
        continue;
      }

      // Edge qualifies for pruning
      if (!cfg.dry_run) {
        this.graph.deleteEdge(edge.id);
      }

      result.pruned_edge_ids.push(edge.id);
      result.pruned_count++;
    }

    return result;
  }
}
