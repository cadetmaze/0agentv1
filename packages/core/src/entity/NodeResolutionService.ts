import type { KnowledgeGraph } from '../graph/KnowledgeGraph.js';
import type { AliasIndex } from './AliasIndex.js';
import type { HNSWIndex } from '../embedding/HNSWIndex.js';
import type { MultimodalEmbedder } from '../embedding/MultimodalEmbedder.js';
import { createNode, NodeType, type GraphNode } from '../graph/GraphNode.js';

export interface ResolutionResult {
  node_id: string;
  confidence: number;
  match_type: 'exact' | 'alias' | 'fuzzy' | 'created';
}

export interface ResolutionConfig {
  exact_threshold: number; // 1.0
  alias_threshold: number; // 0.9
  fuzzy_threshold: number; // 0.65
  disambiguation_threshold: number; // 0.80
}

const DEFAULT_CONFIG: ResolutionConfig = {
  exact_threshold: 1.0,
  alias_threshold: 0.9,
  fuzzy_threshold: 0.65,
  disambiguation_threshold: 0.8,
};

export class NodeResolutionService {
  private config: ResolutionConfig;

  constructor(
    private graph: KnowledgeGraph,
    private aliasIndex: AliasIndex,
    private embedder: MultimodalEmbedder | null,
    private hnswIndex: HNSWIndex | null,
    config?: Partial<ResolutionConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Resolve a mention to an existing node or create a new one.
   *
   * Pipeline:
   * 1. Exact label match in graph
   * 2. Alias match
   * 3. Fuzzy embedding match (if embedder available)
   * 4. Create new node if no match above threshold
   */
  async resolve(
    mention: string,
    opts?: {
      type?: NodeType;
      graph_id?: string;
      context_node_ids?: string[]; // for disambiguation
    },
  ): Promise<ResolutionResult> {
    const graphId = opts?.graph_id ?? 'root';
    const nodeType = opts?.type ?? NodeType.ENTITY;

    // Stage 1: Exact label match
    const exactMatches = this.graph
      .queryStructural({
        graph_id: graphId,
        node_type: nodeType,
        limit: 5,
      })
      .filter((r) => r.node.label.toLowerCase() === mention.toLowerCase());

    if (exactMatches.length === 1) {
      this.graph.touchNode(exactMatches[0].node.id);
      return {
        node_id: exactMatches[0].node.id,
        confidence: this.config.exact_threshold,
        match_type: 'exact',
      };
    }

    // Stage 2: Alias match
    const aliasMatches = this.aliasIndex.findExact(mention);
    if (aliasMatches.length === 1) {
      this.graph.touchNode(aliasMatches[0].node_id);
      return {
        node_id: aliasMatches[0].node_id,
        confidence: aliasMatches[0].confidence,
        match_type: 'alias',
      };
    }

    // If multiple alias matches, try disambiguation
    if (aliasMatches.length > 1 && opts?.context_node_ids?.length) {
      const disambiguated = this.disambiguate(
        aliasMatches.map((a) => a.node_id),
        opts.context_node_ids,
      );
      if (disambiguated) {
        return {
          node_id: disambiguated,
          confidence: this.config.disambiguation_threshold,
          match_type: 'alias',
        };
      }
    }

    // Stage 3: Fuzzy embedding match
    if (this.embedder?.isAvailable && this.hnswIndex) {
      const queryEmbedding = await this.embedder.embedText(mention);
      if (queryEmbedding) {
        const results = this.hnswIndex.search(queryEmbedding, 5);
        const bestMatch = results[0];
        if (bestMatch && bestMatch.similarity >= this.config.fuzzy_threshold) {
          const node = this.graph.getNode(bestMatch.id);
          if (node && node.type === nodeType) {
            this.graph.touchNode(node.id);
            return {
              node_id: node.id,
              confidence: bestMatch.similarity,
              match_type: 'fuzzy',
            };
          }
        }
      }
    }

    // Stage 4: Create new node
    const newNode = this.createNewNode(mention, nodeType, graphId);
    return {
      node_id: newNode.id,
      confidence: 1.0,
      match_type: 'created',
    };
  }

  /**
   * Disambiguate among multiple candidates using context.
   * Check which candidate has edges to/from context nodes.
   * Returns node_id of best candidate, or null if ambiguous.
   */
  private disambiguate(
    candidateIds: string[],
    contextNodeIds: string[],
  ): string | null {
    let bestId: string | null = null;
    let bestScore = 0;

    for (const candidateId of candidateIds) {
      let score = 0;
      for (const ctxId of contextNodeIds) {
        const edges = this.graph.getEdgesBetween(candidateId, ctxId);
        const reverseEdges = this.graph.getEdgesBetween(ctxId, candidateId);
        score += edges.length + reverseEdges.length;
      }
      if (score > bestScore) {
        bestScore = score;
        bestId = candidateId;
      }
    }

    return bestScore > 0 ? bestId : null;
  }

  private createNewNode(
    label: string,
    type: NodeType,
    graphId: string,
  ): GraphNode {
    const id = crypto.randomUUID();
    const node = createNode({
      id,
      graph_id: graphId,
      label,
      type,
    });
    this.graph.addNode(node);
    this.aliasIndex.registerNode(id, label);

    // Add embedding if available
    if (this.embedder?.isAvailable && this.hnswIndex) {
      this.embedder
        .embedText(label)
        .then((emb) => {
          if (emb) {
            this.hnswIndex!.add(id, emb);
            this.graph.updateNode(id, {
              embedding: emb,
              embedding_model: this.embedder!.dimensions.toString(),
              embedding_at: Date.now(),
            });
          }
        })
        .catch(() => {
          /* embedding failure is non-fatal */
        });
    }

    return node;
  }
}
