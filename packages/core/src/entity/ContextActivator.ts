/**
 * ContextActivator — 4-method context activation for 0agent Phase 4.
 *
 * Combines keyword matching, semantic similarity, entity-adjacent graph
 * traversal, and recency boosting to surface the most relevant context
 * nodes for the current input.
 */

import type { KnowledgeGraph } from '../graph/KnowledgeGraph.js';
import type { HNSWIndex } from '../embedding/HNSWIndex.js';
import type { MultimodalEmbedder } from '../embedding/MultimodalEmbedder.js';

// ─── Interfaces ────────────────────────────────────────────

export interface ActivationConfig {
  keyword_weight: number;   // default 1.0
  semantic_weight: number;  // default 0.8
  adjacent_weight: number;  // default 0.6
  recency_weight: number;   // default 0.4
  top_k: number;            // default 10
}

export interface ActivationScore {
  node_id: string;
  score: number;
  reasons: Array<'keyword' | 'semantic' | 'adjacent' | 'recency'>;
}

const DEFAULT_CONFIG: ActivationConfig = {
  keyword_weight: 1.0,
  semantic_weight: 0.8,
  adjacent_weight: 0.6,
  recency_weight: 0.4,
  top_k: 10,
};

// ─── Stop words for keyword matching ───────────────────────

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'between', 'out', 'off', 'over',
  'under', 'again', 'further', 'then', 'once', 'and', 'but', 'or',
  'nor', 'not', 'so', 'yet', 'both', 'either', 'neither', 'each',
  'every', 'all', 'any', 'few', 'more', 'most', 'other', 'some',
  'such', 'no', 'only', 'own', 'same', 'than', 'too', 'very',
  'just', 'because', 'if', 'when', 'where', 'how', 'what', 'which',
  'who', 'whom', 'this', 'that', 'these', 'those', 'i', 'me', 'my',
  'we', 'our', 'you', 'your', 'he', 'him', 'his', 'she', 'her',
  'it', 'its', 'they', 'them', 'their',
]);

// ─── Class ─────────────────────────────────────────────────

export class ContextActivator {
  private graph: KnowledgeGraph;
  private embedder: MultimodalEmbedder | null;
  private hnswIndex: HNSWIndex | null;
  private config: ActivationConfig;

  constructor(
    graph: KnowledgeGraph,
    embedder: MultimodalEmbedder | null,
    hnswIndex: HNSWIndex | null,
    config?: Partial<ActivationConfig>,
  ) {
    this.graph = graph;
    this.embedder = embedder;
    this.hnswIndex = hnswIndex;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Activate context by combining 4 scoring methods.
   * Returns top_k node IDs ordered by score.
   */
  async activate(
    entityIds: string[],
    input: string,
    recentNodeIds?: string[],
  ): Promise<string[]> {
    const scoreMap = new Map<string, ActivationScore>();

    const addScore = (
      nodeId: string,
      score: number,
      reason: 'keyword' | 'semantic' | 'adjacent' | 'recency',
    ): void => {
      const existing = scoreMap.get(nodeId);
      if (existing) {
        existing.score += score;
        if (!existing.reasons.includes(reason)) {
          existing.reasons.push(reason);
        }
      } else {
        scoreMap.set(nodeId, { node_id: nodeId, score, reasons: [reason] });
      }
    };

    // ── Method 1: Keyword match (weight 1.0) ───────────────
    this.keywordMatch(input, addScore);

    // ── Method 2: Semantic similarity (weight 0.8) ─────────
    await this.semanticMatch(input, addScore);

    // ── Method 3: Entity-adjacent (weight 0.6) ─────────────
    this.adjacentMatch(entityIds, addScore);

    // ── Method 4: Recency boost (weight 0.4) ───────────────
    if (recentNodeIds && recentNodeIds.length > 0) {
      this.recencyBoost(recentNodeIds, addScore);
    }

    // Merge and return top_k
    const sorted = Array.from(scoreMap.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, this.config.top_k);

    return sorted.map((s) => s.node_id);
  }

  // ─── Private scoring methods ─────────────────────────────

  /**
   * Method 1: Tokenize input, find nodes whose labels contain overlapping tokens.
   */
  private keywordMatch(
    input: string,
    addScore: (id: string, score: number, reason: 'keyword') => void,
  ): void {
    const tokens = this.tokenize(input);
    if (tokens.length === 0) return;

    // Query a broad set of nodes to check label overlap
    const candidates = this.graph.queryStructural({ limit: 200 });

    for (const result of candidates) {
      const labelTokens = this.tokenize(result.node.label);
      const overlap = labelTokens.filter((t) => tokens.includes(t));
      if (overlap.length > 0) {
        const score =
          (overlap.length / Math.max(labelTokens.length, 1)) *
          this.config.keyword_weight;
        addScore(result.node.id, score, 'keyword');
      }
    }
  }

  /**
   * Method 2: HNSW search using input embedding.
   */
  private async semanticMatch(
    input: string,
    addScore: (id: string, score: number, reason: 'semantic') => void,
  ): Promise<void> {
    if (!this.embedder?.isAvailable || !this.hnswIndex) return;

    const queryEmb = await this.embedder.embedText(input);
    if (!queryEmb) return;

    const results = this.hnswIndex.search(queryEmb, this.config.top_k * 2);
    for (const hit of results) {
      const score = hit.similarity * this.config.semantic_weight;
      addScore(hit.id, score, 'semantic');
    }
  }

  /**
   * Method 3: 2-hop neighbors of resolved entity IDs.
   * 1st hop gets full adjacent_weight, 2nd hop gets 0.5x.
   */
  private adjacentMatch(
    entityIds: string[],
    addScore: (id: string, score: number, reason: 'adjacent') => void,
  ): void {
    const visited = new Set<string>(entityIds);

    // 1st hop
    const firstHopIds: string[] = [];
    for (const entityId of entityIds) {
      const edges = this.graph.getEdgesByNode(entityId, 'both');
      for (const edge of edges) {
        const neighborId =
          edge.from_node === entityId ? edge.to_node : edge.from_node;
        if (!visited.has(neighborId)) {
          visited.add(neighborId);
          firstHopIds.push(neighborId);
          addScore(neighborId, this.config.adjacent_weight, 'adjacent');
        }
      }
    }

    // 2nd hop (0.5x weight)
    for (const hopId of firstHopIds) {
      const edges = this.graph.getEdgesByNode(hopId, 'both');
      for (const edge of edges) {
        const neighborId =
          edge.from_node === hopId ? edge.to_node : edge.from_node;
        if (!visited.has(neighborId)) {
          visited.add(neighborId);
          addScore(
            neighborId,
            this.config.adjacent_weight * 0.5,
            'adjacent',
          );
        }
      }
    }
  }

  /**
   * Method 4: Boost recently accessed node IDs.
   */
  private recencyBoost(
    recentNodeIds: string[],
    addScore: (id: string, score: number, reason: 'recency') => void,
  ): void {
    // More recent = higher boost; linear decay over the list
    const total = recentNodeIds.length;
    for (let i = 0; i < total; i++) {
      const recencyFactor = (i + 1) / total; // newer items are at end
      const score = recencyFactor * this.config.recency_weight;
      addScore(recentNodeIds[i], score, 'recency');
    }
  }

  // ─── Utility ─────────────────────────────────────────────

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .split(/\W+/)
      .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
  }
}
