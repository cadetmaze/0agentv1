/**
 * EntityResolutionPipeline — 4-stage entity resolution for 0agent Phase 4.
 *
 * Stage 1: Extract entities from input (LLM or regex fallback)
 * Stage 2: Graph lookup (exact → alias → fuzzy → create)
 * Stage 3: Disambiguate multiple candidates
 * Stage 4: Context activation
 */

import type { KnowledgeGraph } from '../graph/KnowledgeGraph.js';
import type { AliasIndex } from './AliasIndex.js';
import type { HNSWIndex } from '../embedding/HNSWIndex.js';
import type { MultimodalEmbedder } from '../embedding/MultimodalEmbedder.js';
import type { ContextActivator } from './ContextActivator.js';
import type { WorkingMemory } from '../memory/WorkingMemory.js';
import { NodeType, createNode } from '../graph/GraphNode.js';

// ─── Interfaces ────────────────────────────────────────────

export interface IEntityExtractor {
  extract(text: string): Promise<ExtractionResult>;
}

export interface ExtractionResult {
  entities: Array<{
    text: string;
    type: NodeType;
    confidence: number;
  }>;
}

export interface PipelineResult {
  resolved_entities: Array<{
    node_id: string;
    original_text: string;
    match_type: 'exact' | 'alias' | 'fuzzy' | 'created' | 'disambiguated';
    confidence: number;
  }>;
  activated_context: string[];
}

// ─── Simple fallback extractor ─────────────────────────────

/**
 * Regex-based fallback: finds capitalized words and adjacent capitalized pairs.
 */
function simpleExtract(text: string): ExtractionResult {
  const entities: ExtractionResult['entities'] = [];
  const seen = new Set<string>();

  // Match capitalized word sequences (2+ chars), excluding sentence starts after '. '
  const pattern = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const candidate = match[1];
    // Skip very short or common words
    if (candidate.length < 2) continue;
    const lower = candidate.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);

    entities.push({
      text: candidate,
      type: NodeType.ENTITY,
      confidence: 0.6,
    });
  }

  return { entities };
}

// ─── Pipeline ──────────────────────────────────────────────

export class EntityResolutionPipeline {
  private graph: KnowledgeGraph;
  private aliasIndex: AliasIndex;
  private embedder: MultimodalEmbedder | null;
  private hnswIndex: HNSWIndex | null;
  private contextActivator: ContextActivator;
  private extractor: IEntityExtractor | null;

  constructor(
    graph: KnowledgeGraph,
    aliasIndex: AliasIndex,
    embedder: MultimodalEmbedder | null,
    hnswIndex: HNSWIndex | null,
    contextActivator: ContextActivator,
    extractor: IEntityExtractor | null,
  ) {
    this.graph = graph;
    this.aliasIndex = aliasIndex;
    this.embedder = embedder;
    this.hnswIndex = hnswIndex;
    this.contextActivator = contextActivator;
    this.extractor = extractor;
  }

  async resolve(input: string, workingMemory?: WorkingMemory): Promise<PipelineResult> {
    // ── Stage 1: Extract entities ──────────────────────────
    const extraction = this.extractor
      ? await this.extractor.extract(input)
      : simpleExtract(input);

    const resolved: PipelineResult['resolved_entities'] = [];

    for (const entity of extraction.entities) {
      // ── Stage 2: Graph lookup ────────────────────────────
      const result = await this.lookupEntity(entity.text, entity.type);

      // ── Stage 3: Disambiguate ────────────────────────────
      if (result.candidates.length > 1) {
        const best = this.disambiguate(result.candidates, workingMemory);
        resolved.push({
          node_id: best.node_id,
          original_text: entity.text,
          match_type: 'disambiguated',
          confidence: best.confidence,
        });
      } else if (result.candidates.length === 1) {
        const c = result.candidates[0];
        resolved.push({
          node_id: c.node_id,
          original_text: entity.text,
          match_type: c.match_type,
          confidence: c.confidence,
        });
      } else {
        // Create new node
        const newNode = this.createEntity(entity.text, entity.type);
        resolved.push({
          node_id: newNode,
          original_text: entity.text,
          match_type: 'created',
          confidence: 1.0,
        });
      }
    }

    // ── Stage 4: Context activation ────────────────────────
    const entityIds = resolved.map((r) => r.node_id);
    const recentNodeIds = workingMemory
      ? workingMemory.getRecentNodes(20).map((n) => n.id)
      : [];
    const activatedContext = await this.contextActivator.activate(
      entityIds,
      input,
      recentNodeIds,
    );

    return {
      resolved_entities: resolved,
      activated_context: activatedContext,
    };
  }

  // ─── Private helpers ─────────────────────────────────────

  private async lookupEntity(
    text: string,
    type: NodeType,
  ): Promise<{
    candidates: Array<{
      node_id: string;
      match_type: 'exact' | 'alias' | 'fuzzy';
      confidence: number;
    }>;
  }> {
    const candidates: Array<{
      node_id: string;
      match_type: 'exact' | 'alias' | 'fuzzy';
      confidence: number;
    }> = [];

    // 2a: Exact label match
    const exactResults = this.graph
      .queryStructural({ node_type: type, limit: 10 })
      .filter((r) => r.node.label.toLowerCase() === text.toLowerCase());

    for (const r of exactResults) {
      candidates.push({
        node_id: r.node.id,
        match_type: 'exact',
        confidence: 1.0,
      });
    }

    if (candidates.length > 0) return { candidates };

    // 2b: Alias match
    const aliasMatches = this.aliasIndex.findExact(text);
    for (const a of aliasMatches) {
      candidates.push({
        node_id: a.node_id,
        match_type: 'alias',
        confidence: a.confidence,
      });
    }

    if (candidates.length > 0) return { candidates };

    // 2c: Fuzzy embedding match (similarity >= 0.65)
    if (this.embedder?.isAvailable && this.hnswIndex) {
      const queryEmbedding = await this.embedder.embedText(text);
      if (queryEmbedding) {
        const results = this.hnswIndex.search(queryEmbedding, 5);
        for (const hit of results) {
          if (hit.similarity >= 0.65) {
            const node = this.graph.getNode(hit.id);
            if (node && node.type === type) {
              candidates.push({
                node_id: node.id,
                match_type: 'fuzzy',
                confidence: hit.similarity,
              });
            }
          }
        }
      }
    }

    return { candidates };
  }

  private disambiguate(
    candidates: Array<{
      node_id: string;
      match_type: 'exact' | 'alias' | 'fuzzy';
      confidence: number;
    }>,
    workingMemory?: WorkingMemory,
  ): { node_id: string; confidence: number } {
    // Pick highest confidence candidate
    let best = candidates[0];
    for (const c of candidates) {
      if (c.confidence > best.confidence) {
        best = c;
      }
    }

    // If below 0.80 threshold, use working memory context to break tie
    if (best.confidence < 0.80 && workingMemory) {
      const recentIds = new Set(
        workingMemory.getRecentNodes(20).map((n) => n.id),
      );

      let contextBest: typeof best | null = null;
      let contextBestScore = -1;

      for (const c of candidates) {
        // Score by adjacency to recent context
        const edges = this.graph.getEdgesByNode(c.node_id, 'both');
        let score = 0;
        for (const edge of edges) {
          const neighborId =
            edge.from_node === c.node_id ? edge.to_node : edge.from_node;
          if (recentIds.has(neighborId)) score++;
        }
        if (score > contextBestScore) {
          contextBestScore = score;
          contextBest = c;
        }
      }

      if (contextBest && contextBestScore > 0) {
        return {
          node_id: contextBest.node_id,
          confidence: Math.max(contextBest.confidence, 0.80),
        };
      }
    }

    return { node_id: best.node_id, confidence: best.confidence };
  }

  private createEntity(label: string, type: NodeType): string {
    const id = crypto.randomUUID();
    const node = createNode({
      id,
      graph_id: 'root',
      label,
      type,
    });
    this.graph.addNode(node);
    this.aliasIndex.registerNode(id, label);

    // Embed asynchronously if available
    if (this.embedder?.isAvailable && this.hnswIndex) {
      const embedder = this.embedder;
      const hnswIndex = this.hnswIndex;
      const graph = this.graph;
      embedder
        .embedText(label)
        .then((emb) => {
          if (emb) {
            hnswIndex.add(id, emb);
            graph.updateNode(id, {
              embedding: emb,
              embedding_model: embedder.dimensions.toString(),
              embedding_at: Date.now(),
            });
          }
        })
        .catch(() => {
          /* embedding failure is non-fatal */
        });
    }

    return id;
  }
}
