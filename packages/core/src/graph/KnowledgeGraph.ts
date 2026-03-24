import { SQLiteAdapter } from '../storage/adapters/SQLiteAdapter.js';
import { GraphNode, NodeType, NodeContent } from './GraphNode.js';
import { GraphEdge, EdgeType } from './GraphEdge.js';
import { SubGraph } from './SubGraph.js';
import {
  GraphQuery,
  QueryResult,
  StructuralQueryOpts,
  SemanticQueryOpts,
  MergedQueryOpts,
} from './GraphQuery.js';

export class KnowledgeGraph {
  private adapter: SQLiteAdapter;
  // HNSWIndex is optional — semantic queries return empty if not set
  private hnswIndex: any | null;

  constructor(adapter: SQLiteAdapter, hnswIndex?: any) {
    this.adapter = adapter;
    this.hnswIndex = hnswIndex ?? null;
  }

  // ─── Node CRUD ────────────────────────────

  addNode(node: GraphNode): void {
    this.adapter.insertNode(node);
    if (node.embedding && this.hnswIndex) {
      this.hnswIndex.add(node.id, node.embedding);
    }
  }

  getNode(id: string): GraphNode | null {
    return this.adapter.getNode(id);
  }

  updateNode(
    id: string,
    updates: Partial<Pick<GraphNode, 'label' | 'metadata' | 'embedding' | 'embedding_model' | 'embedding_at'>>,
  ): void {
    const existing = this.adapter.getNode(id);
    if (!existing) {
      throw new Error(`Node not found: ${id}`);
    }

    // Build updated node for re-insertion of changed fields
    if (updates.label !== undefined) {
      existing.label = updates.label;
    }
    if (updates.metadata !== undefined) {
      existing.metadata = updates.metadata;
    }
    if (updates.embedding !== undefined) {
      existing.embedding = updates.embedding;
      if (updates.embedding && this.hnswIndex) {
        this.hnswIndex.add(id, updates.embedding);
      }
    }
    if (updates.embedding_model !== undefined) {
      existing.embedding_model = updates.embedding_model;
    }
    if (updates.embedding_at !== undefined) {
      existing.embedding_at = updates.embedding_at;
    }

    // Delete and re-insert to update all fields
    this.adapter.deleteNode(id);
    this.adapter.insertNode(existing);
  }

  touchNode(id: string): void {
    this.adapter.updateNodeLastSeen(id, Date.now());
  }

  deleteNode(id: string): void {
    this.adapter.deleteNode(id);
    if (this.hnswIndex) {
      try {
        this.hnswIndex.remove(id);
      } catch {
        // Ignore if not in index
      }
    }
  }

  // ─── Node Content ─────────────────────────

  addContent(nodeId: string, content: NodeContent): void {
    const node = this.adapter.getNode(nodeId);
    if (!node) {
      throw new Error(`Node not found: ${nodeId}`);
    }
    this.adapter.insertNodeContent(content);
  }

  getContent(nodeId: string): NodeContent[] {
    return this.adapter.getNodeContent(nodeId);
  }

  // ─── Edge CRUD ────────────────────────────

  addEdge(edge: GraphEdge): void {
    this.adapter.insertEdge(edge);
  }

  getEdge(id: string): GraphEdge | null {
    return this.adapter.getEdge(id);
  }

  deleteEdge(id: string): void {
    this.adapter.deleteEdge(id);
  }

  getEdgesFrom(nodeId: string): GraphEdge[] {
    return this.adapter.getEdgesByNode(nodeId, 'from');
  }

  getEdgesTo(nodeId: string): GraphEdge[] {
    return this.adapter.getEdgesByNode(nodeId, 'to');
  }

  getEdgesByNode(nodeId: string, direction: 'from' | 'to' | 'both'): GraphEdge[] {
    return this.adapter.getEdgesByNode(nodeId, direction);
  }

  getEdgesBetween(fromId: string, toId: string): GraphEdge[] {
    const edges = this.adapter.getEdgesByNode(fromId, 'from');
    return edges.filter((e) => e.to_node === toId);
  }

  getAllEdges(graphId?: string): GraphEdge[] {
    return this.adapter.getAllEdges(graphId);
  }

  // ─── Subgraph ─────────────────────────────

  /**
   * BFS from entity node, loading nodes + edges up to `depth` hops.
   */
  getSubGraph(entityId: string, depth: number = 2): SubGraph {
    const rootNode = this.adapter.getNode(entityId);
    if (!rootNode) {
      throw new Error(`Entity node not found: ${entityId}`);
    }

    const subgraph = new SubGraph(entityId, entityId);
    subgraph.addNode(rootNode);

    let frontier = new Set<string>([entityId]);
    const visited = new Set<string>([entityId]);

    for (let d = 0; d < depth; d++) {
      const nextFrontier = new Set<string>();

      for (const nodeId of frontier) {
        const outEdges = this.adapter.getEdgesByNode(nodeId, 'both');

        for (const edge of outEdges) {
          subgraph.addEdge(edge);

          // Determine the neighbor node
          const neighborId = edge.from_node === nodeId ? edge.to_node : edge.from_node;

          if (!visited.has(neighborId)) {
            visited.add(neighborId);
            const neighborNode = this.adapter.getNode(neighborId);
            if (neighborNode) {
              subgraph.addNode(neighborNode);
              nextFrontier.add(neighborId);
            }
          }
        }
      }

      frontier = nextFrontier;
      if (frontier.size === 0) break;
    }

    return subgraph;
  }

  // ─── Query ────────────────────────────────

  queryStructural(opts: StructuralQueryOpts): QueryResult[] {
    const results: QueryResult[] = [];
    const limit = opts.limit ?? 50;

    if (opts.from_node) {
      // Get edges from the specified node
      let edges = this.adapter.getEdgesByNode(opts.from_node, 'from');

      // Filter by edge type
      if (opts.edge_type) {
        edges = edges.filter((e) => e.type === opts.edge_type);
      }

      // Filter by weight range
      if (opts.min_weight !== undefined) {
        edges = edges.filter((e) => e.weight >= opts.min_weight!);
      }
      if (opts.max_weight !== undefined) {
        edges = edges.filter((e) => e.weight <= opts.max_weight!);
      }

      // Filter by graph_id
      if (opts.graph_id) {
        edges = edges.filter((e) => e.graph_id === opts.graph_id);
      }

      // Resolve target nodes
      for (const edge of edges) {
        const targetNode = this.adapter.getNode(edge.to_node);
        if (!targetNode) continue;

        // Filter by node type
        if (opts.node_type && targetNode.type !== opts.node_type) continue;

        results.push({
          node: targetNode,
          score: edge.weight,
          source: 'structural',
        });
      }
    } else if (opts.to_node) {
      // Get edges to the specified node
      let edges = this.adapter.getEdgesByNode(opts.to_node, 'to');

      if (opts.edge_type) {
        edges = edges.filter((e) => e.type === opts.edge_type);
      }
      if (opts.min_weight !== undefined) {
        edges = edges.filter((e) => e.weight >= opts.min_weight!);
      }
      if (opts.max_weight !== undefined) {
        edges = edges.filter((e) => e.weight <= opts.max_weight!);
      }
      if (opts.graph_id) {
        edges = edges.filter((e) => e.graph_id === opts.graph_id);
      }

      for (const edge of edges) {
        const sourceNode = this.adapter.getNode(edge.from_node);
        if (!sourceNode) continue;
        if (opts.node_type && sourceNode.type !== opts.node_type) continue;

        results.push({
          node: sourceNode,
          score: edge.weight,
          source: 'structural',
        });
      }
    } else if (opts.graph_id || opts.node_type) {
      // Query nodes directly by graph_id and/or type
      const nodes = this.adapter.queryNodes({
        graph_id: opts.graph_id,
        type: opts.node_type,
        limit,
      });

      for (const node of nodes) {
        results.push({
          node,
          score: 1.0, // No edge weight context, default to 1.0
          source: 'structural',
        });
      }
    }

    // Sort results
    this.sortResults(results, opts.order_by ?? 'weight_desc');

    return results.slice(0, limit);
  }

  querySemantic(opts: SemanticQueryOpts): QueryResult[] {
    if (!this.hnswIndex) {
      return [];
    }

    const limit = opts.limit ?? 20;
    const minSimilarity = opts.min_similarity ?? 0.0;

    let searchResults: Array<{ id: string; similarity: number }>;
    try {
      searchResults = this.hnswIndex.search(opts.embedding, limit * 2); // oversample for filtering
    } catch {
      return [];
    }

    const results: QueryResult[] = [];

    for (const hit of searchResults) {
      if (hit.similarity < minSimilarity) continue;

      const node = this.adapter.getNode(hit.id);
      if (!node) continue;

      // Filter by node types if specified
      if (opts.node_types && opts.node_types.length > 0) {
        if (!opts.node_types.includes(node.type as NodeType)) continue;
      }

      results.push({
        node,
        score: hit.similarity,
        source: 'semantic',
      });

      if (results.length >= limit) break;
    }

    return results;
  }

  queryMerged(opts: MergedQueryOpts): QueryResult[] {
    const structuralWeight = opts.structural_weight ?? 0.6;
    const semanticWeight = opts.semantic_weight ?? 0.4;
    const limit = opts.limit ?? 50;

    // Run structural query
    const structuralResults = this.queryStructural(opts.structural);

    // Run semantic query if provided
    const semanticResults = opts.semantic
      ? this.querySemantic(opts.semantic)
      : [];

    // Build score maps keyed by node id
    const scoreMap = new Map<string, { node: GraphNode; structScore: number; semScore: number }>();

    for (const r of structuralResults) {
      scoreMap.set(r.node.id, {
        node: r.node,
        structScore: r.score,
        semScore: 0,
      });
    }

    for (const r of semanticResults) {
      const existing = scoreMap.get(r.node.id);
      if (existing) {
        existing.semScore = r.score;
      } else {
        scoreMap.set(r.node.id, {
          node: r.node,
          structScore: 0,
          semScore: r.score,
        });
      }
    }

    // Compute merged scores
    const merged: QueryResult[] = [];
    for (const entry of scoreMap.values()) {
      const score = structuralWeight * entry.structScore + semanticWeight * entry.semScore;
      merged.push({
        node: entry.node,
        score,
        source: 'merged',
      });
    }

    // Sort by score descending
    merged.sort((a, b) => b.score - a.score);

    return merged.slice(0, limit);
  }

  query(q: GraphQuery): QueryResult[] {
    const merged = q.getMergedOpts();
    const structOpts = q.getStructuralOpts();
    const semOpts = q.getSemanticOpts();

    // Pure semantic query
    if (!structOpts && semOpts) {
      return this.querySemantic(semOpts);
    }

    // Pure structural query
    if (structOpts && !semOpts) {
      return this.queryStructural(structOpts);
    }

    // Merged query
    return this.queryMerged(merged);
  }

  // ─── Stats ────────────────────────────────

  nodeCount(graphId?: string): number {
    return this.adapter.countNodes(graphId);
  }

  edgeCount(graphId?: string): number {
    return this.adapter.countEdges(graphId);
  }

  // ─── Lifecycle ────────────────────────────

  close(): void {
    this.adapter.close();
  }

  // ─── Private helpers ──────────────────────

  private sortResults(
    results: QueryResult[],
    orderBy: 'weight_desc' | 'weight_asc' | 'created_at_desc' | 'traversal_count_desc',
  ): void {
    switch (orderBy) {
      case 'weight_desc':
        results.sort((a, b) => b.score - a.score);
        break;
      case 'weight_asc':
        results.sort((a, b) => a.score - b.score);
        break;
      case 'created_at_desc':
        results.sort((a, b) => b.node.created_at - a.node.created_at);
        break;
      case 'traversal_count_desc':
        results.sort((a, b) => b.node.visit_count - a.node.visit_count);
        break;
    }
  }
}
