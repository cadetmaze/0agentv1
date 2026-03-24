import { randomUUID } from 'node:crypto';
import type { KnowledgeGraph } from '../graph/KnowledgeGraph.js';
import type { ObjectStore } from '../storage/ObjectStore.js';
import type { GraphNode } from '../graph/GraphNode.js';
import type { GraphEdge } from '../graph/GraphEdge.js';

export interface Checkpoint {
  id: string;
  name: string;
  created_at: number;
  node_count: number;
  edge_count: number;
  storage_ref: string;
}

export interface CheckpointSnapshot {
  checkpoint_id: string;
  created_at: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export class GraphCheckpointManager {
  private checkpoints: Map<string, Checkpoint> = new Map();

  constructor(
    private graph: KnowledgeGraph,
    private objectStore: ObjectStore,
  ) {}

  /**
   * Create a named checkpoint by snapshotting all current nodes and edges
   * into the ObjectStore.
   */
  async create(name: string): Promise<Checkpoint> {
    const id = randomUUID();
    const now = Date.now();

    // Snapshot all nodes and edges from the graph
    const nodes = this.graph.queryStructural({ limit: 100_000 }).map((r) => r.node);
    const edges = this.graph.getAllEdges();

    const snapshot: CheckpointSnapshot = {
      checkpoint_id: id,
      created_at: now,
      nodes,
      edges,
    };

    const ref = await this.objectStore.put(JSON.stringify(snapshot), {
      prefix: 'checkpoints',
      extension: '.json',
    });

    const checkpoint: Checkpoint = {
      id,
      name,
      created_at: now,
      node_count: nodes.length,
      edge_count: edges.length,
      storage_ref: ref,
    };

    this.checkpoints.set(id, checkpoint);
    return checkpoint;
  }

  /**
   * Load the full snapshot data for a checkpoint from the ObjectStore.
   */
  async getSnapshot(checkpointId: string): Promise<CheckpointSnapshot | null> {
    const cp = this.checkpoints.get(checkpointId);
    if (!cp) return null;

    const data = await this.objectStore.get(cp.storage_ref);
    return JSON.parse(data.toString()) as CheckpointSnapshot;
  }

  /**
   * Get checkpoint metadata by id.
   */
  get(id: string): Checkpoint | null {
    return this.checkpoints.get(id) ?? null;
  }

  /**
   * Find a checkpoint by its human-readable name.
   */
  getByName(name: string): Checkpoint | null {
    for (const cp of this.checkpoints.values()) {
      if (cp.name === name) return cp;
    }
    return null;
  }

  /**
   * List all checkpoints, newest first.
   */
  list(): Checkpoint[] {
    return [...this.checkpoints.values()].sort((a, b) => b.created_at - a.created_at);
  }

  /**
   * Remove a checkpoint from the in-memory registry.
   * Does NOT delete the ObjectStore blob (call objectStore.delete separately if needed).
   */
  delete(id: string): void {
    this.checkpoints.delete(id);
  }
}
