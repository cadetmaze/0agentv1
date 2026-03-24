import type { KnowledgeGraph } from '../graph/KnowledgeGraph.js';
import type { GraphNode } from '../graph/GraphNode.js';
import type { GraphEdge } from '../graph/GraphEdge.js';

export interface DeduplicationConfig {
  cosine_threshold: number; // default 0.92
  dry_run: boolean;
}

export interface MergeCandidate {
  node_a_id: string;
  node_b_id: string;
  similarity: number;
  surviving_node_id: string;
  removed_node_id: string;
}

export interface DeduplicationResult {
  merged_count: number;
  candidates_found: number;
  candidates: MergeCandidate[];
}

const DEFAULT_CONFIG: DeduplicationConfig = {
  cosine_threshold: 0.92,
  dry_run: false,
};

export class NodeDeduplicator {
  constructor(private graph: KnowledgeGraph) {}

  run(config?: Partial<DeduplicationConfig>): DeduplicationResult {
    const cfg: DeduplicationConfig = { ...DEFAULT_CONFIG, ...config };

    const result: DeduplicationResult = {
      merged_count: 0,
      candidates_found: 0,
      candidates: [],
    };

    // Collect all nodes that have embeddings, grouped by type
    const allEdges = this.graph.getAllEdges();
    const nodeIds = new Set<string>();
    for (const edge of allEdges) {
      nodeIds.add(edge.from_node);
      nodeIds.add(edge.to_node);
    }

    // Also gather nodes from the graph by resolving each unique id
    const nodesWithEmbeddings: GraphNode[] = [];
    for (const id of nodeIds) {
      const node = this.graph.getNode(id);
      if (node && node.embedding) {
        nodesWithEmbeddings.push(node);
      }
    }

    // Track which nodes have been removed so we don't merge already-removed nodes
    const removedIds = new Set<string>();

    // Pairwise cosine similarity (O(n^2) — acceptable for weekly maintenance)
    for (let i = 0; i < nodesWithEmbeddings.length; i++) {
      if (removedIds.has(nodesWithEmbeddings[i].id)) continue;

      for (let j = i + 1; j < nodesWithEmbeddings.length; j++) {
        if (removedIds.has(nodesWithEmbeddings[j].id)) continue;

        const nodeA = nodesWithEmbeddings[i];
        const nodeB = nodesWithEmbeddings[j];

        // Never merge different types
        if (nodeA.type !== nodeB.type) continue;

        const similarity = this.cosineSimilarity(nodeA.embedding!, nodeB.embedding!);

        if (similarity < cfg.cosine_threshold) continue;

        // Surviving node = higher visit_count
        const surviving = nodeA.visit_count >= nodeB.visit_count ? nodeA : nodeB;
        const removed = surviving === nodeA ? nodeB : nodeA;

        const candidate: MergeCandidate = {
          node_a_id: nodeA.id,
          node_b_id: nodeB.id,
          similarity,
          surviving_node_id: surviving.id,
          removed_node_id: removed.id,
        };

        result.candidates_found++;
        result.candidates.push(candidate);

        if (!cfg.dry_run) {
          this.mergeNodes(candidate);
          removedIds.add(removed.id);
          result.merged_count++;
        }
      }
    }

    return result;
  }

  mergeNodes(candidate: MergeCandidate): void {
    const surviving = this.graph.getNode(candidate.surviving_node_id);
    const removed = this.graph.getNode(candidate.removed_node_id);

    if (!surviving || !removed) return;

    // Merge visit counts
    const newVisitCount = surviving.visit_count + removed.visit_count;

    // Deep merge metadata (surviving wins conflicts)
    const newMetadata = this.deepMerge(removed.metadata, surviving.metadata);

    this.graph.updateNode(surviving.id, {
      metadata: { ...newMetadata, _visit_count_merged: newVisitCount },
    });

    // We need to update visit_count — but updateNode only supports label/metadata/embedding fields.
    // Re-read, delete, and re-insert with correct visit_count via the node itself.
    const updatedSurviving = this.graph.getNode(surviving.id);
    if (updatedSurviving) {
      // Manually fix visit_count through delete/re-add cycle
      this.graph.deleteNode(surviving.id);
      updatedSurviving.visit_count = newVisitCount;
      updatedSurviving.metadata = newMetadata;
      delete (updatedSurviving.metadata as Record<string, unknown>)._visit_count_merged;
      this.graph.addNode(updatedSurviving);
    }

    // Re-point all edges from removed node → surviving node
    const removedEdges = this.graph.getEdgesByNode(removed.id, 'both');
    for (const edge of removedEdges) {
      const isFrom = edge.from_node === removed.id;
      const newFrom = isFrom ? surviving.id : edge.from_node;
      const newTo = isFrom ? edge.to_node : surviving.id;

      // Skip self-loops that would form
      if (newFrom === newTo) {
        this.graph.deleteEdge(edge.id);
        continue;
      }

      // Check if a duplicate edge already exists between these nodes
      const existingEdges = this.graph.getEdgesBetween(newFrom, newTo);
      const duplicateEdge = existingEdges.find((e) => e.type === edge.type);

      if (duplicateEdge) {
        // Merge weights: take max weight, sum traversal counts
        const mergedWeight = Math.max(duplicateEdge.weight, edge.weight);
        const mergedTraversalCount = duplicateEdge.traversal_count + edge.traversal_count;

        // Delete both and re-create merged edge
        this.graph.deleteEdge(edge.id);
        this.graph.deleteEdge(duplicateEdge.id);

        const mergedEdge: GraphEdge = {
          ...duplicateEdge,
          weight: mergedWeight,
          traversal_count: mergedTraversalCount,
        };
        this.graph.addEdge(mergedEdge);
      } else {
        // Re-point edge
        this.graph.deleteEdge(edge.id);
        const repointed: GraphEdge = {
          ...edge,
          from_node: newFrom,
          to_node: newTo,
        };
        this.graph.addEdge(repointed);
      }
    }

    // Delete the removed node
    this.graph.deleteNode(removed.id);
  }

  private cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    if (denominator === 0) return 0;

    return dotProduct / denominator;
  }

  private deepMerge(
    base: Record<string, unknown>,
    override: Record<string, unknown>,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = { ...base };

    for (const key of Object.keys(override)) {
      const baseVal = base[key];
      const overrideVal = override[key];

      if (
        typeof baseVal === 'object' &&
        baseVal !== null &&
        !Array.isArray(baseVal) &&
        typeof overrideVal === 'object' &&
        overrideVal !== null &&
        !Array.isArray(overrideVal)
      ) {
        result[key] = this.deepMerge(
          baseVal as Record<string, unknown>,
          overrideVal as Record<string, unknown>,
        );
      } else {
        result[key] = overrideVal;
      }
    }

    return result;
  }
}
