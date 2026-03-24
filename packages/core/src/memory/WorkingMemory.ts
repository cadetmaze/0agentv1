/**
 * WorkingMemory — LRU cache over the knowledge graph for 0agent Phase 4.
 *
 * Provides fast access to recently-used graph nodes with automatic
 * eviction when the cache exceeds max_nodes.
 */

import type { GraphNode } from '../graph/GraphNode.js';
import type { KnowledgeGraph } from '../graph/KnowledgeGraph.js';

export interface WorkingMemoryConfig {
  max_nodes: number; // default 200
}

export class WorkingMemory {
  private cache: Map<string, GraphNode>;
  private config: WorkingMemoryConfig;

  constructor(
    private graph: KnowledgeGraph,
    config?: Partial<WorkingMemoryConfig>,
  ) {
    this.cache = new Map();
    this.config = { max_nodes: config?.max_nodes ?? 200 };
  }

  /**
   * Get a node by ID. Checks cache first (promoting to MRU on hit),
   * then falls back to graph lookup and caches the result.
   */
  get(id: string): GraphNode | null {
    // Check cache first, move to end on hit (LRU promotion)
    if (this.cache.has(id)) {
      const node = this.cache.get(id)!;
      this.cache.delete(id);
      this.cache.set(id, node);
      return node;
    }
    // Cache miss: load from graph
    const node = this.graph.getNode(id);
    if (node) this.put(node);
    return node;
  }

  /**
   * Insert or update a node in the cache.
   * Evicts the LRU entry if at capacity.
   */
  put(node: GraphNode): void {
    // If already present, delete first to re-insert at end
    if (this.cache.has(node.id)) {
      this.cache.delete(node.id);
    } else if (this.cache.size >= this.config.max_nodes) {
      // Evict LRU (first entry in Map iteration order)
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    this.cache.set(node.id, node);
  }

  /**
   * Get the N most recently accessed nodes (from oldest to newest).
   */
  getRecentNodes(n: number): GraphNode[] {
    return Array.from(this.cache.values()).slice(-n);
  }

  /** Check if a node is in the cache. */
  has(id: string): boolean {
    return this.cache.has(id);
  }

  /** Number of nodes currently cached. */
  get size(): number {
    return this.cache.size;
  }

  /** Clear all cached nodes. */
  clear(): void {
    this.cache.clear();
  }
}
