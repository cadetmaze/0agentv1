import type { KnowledgeGraph } from '../graph/KnowledgeGraph.js';
import type { ObjectStore } from '../storage/ObjectStore.js';
import type { GraphNode } from '../graph/GraphNode.js';
import type { GraphEdge } from '../graph/GraphEdge.js';
import { NodeType } from '../graph/GraphNode.js';

export interface ArchivalConfig {
  inactive_days: number; // default 30
  dry_run: boolean;
}

export interface ArchivalResult {
  archived_count: number;
  archived_subgraph_ids: string[];
}

interface ArchivedSubgraph {
  entity_id: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  archived_at: number;
}

const DEFAULT_CONFIG: ArchivalConfig = {
  inactive_days: 30,
  dry_run: false,
};

export class SubgraphArchiver {
  constructor(
    private graph: KnowledgeGraph,
    private objectStore: ObjectStore,
  ) {}

  async archiveCold(config?: Partial<ArchivalConfig>): Promise<ArchivalResult> {
    const cfg: ArchivalConfig = { ...DEFAULT_CONFIG, ...config };

    const result: ArchivalResult = {
      archived_count: 0,
      archived_subgraph_ids: [],
    };

    const inactiveThresholdMs = cfg.inactive_days * 24 * 60 * 60 * 1000;
    const now = Date.now();

    // Find entity nodes not accessed in inactive_days
    const allEdges = this.graph.getAllEdges();
    const nodeIds = new Set<string>();
    for (const edge of allEdges) {
      nodeIds.add(edge.from_node);
      nodeIds.add(edge.to_node);
    }

    const entityNodes: GraphNode[] = [];
    for (const id of nodeIds) {
      const node = this.graph.getNode(id);
      if (
        node &&
        node.type === NodeType.ENTITY &&
        now - node.last_seen >= inactiveThresholdMs
      ) {
        entityNodes.push(node);
      }
    }

    for (const entity of entityNodes) {
      // Get the subgraph rooted at this entity
      let subgraph;
      try {
        subgraph = this.graph.getSubGraph(entity.id, 2);
      } catch {
        // Entity may have been removed by a prior archival in this run
        continue;
      }

      const nodes: GraphNode[] = [];
      const edges: GraphEdge[] = [];

      // Collect nodes from the subgraph
      // SubGraph stores nodes/edges internally; walk via the entity's edges
      const subgraphEdges = this.graph.getEdgesByNode(entity.id, 'both');
      const visitedNodes = new Set<string>([entity.id]);
      const nodeQueue = [entity.id];

      // BFS to depth 2
      let depth = 0;
      while (nodeQueue.length > 0 && depth < 2) {
        const levelSize = nodeQueue.length;
        for (let i = 0; i < levelSize; i++) {
          const currentId = nodeQueue.shift()!;
          const currentEdges = this.graph.getEdgesByNode(currentId, 'both');

          for (const edge of currentEdges) {
            if (!edges.find((e) => e.id === edge.id)) {
              edges.push(edge);
            }

            const neighborId =
              edge.from_node === currentId ? edge.to_node : edge.from_node;
            if (!visitedNodes.has(neighborId)) {
              visitedNodes.add(neighborId);
              const neighborNode = this.graph.getNode(neighborId);
              if (neighborNode) {
                nodeQueue.push(neighborId);
              }
            }
          }
        }
        depth++;
      }

      // Gather all visited nodes
      for (const nodeId of visitedNodes) {
        const node = this.graph.getNode(nodeId);
        if (node) {
          // Serialize embedding for JSON storage
          nodes.push({
            ...node,
            embedding: node.embedding
              ? new Float32Array(node.embedding)
              : null,
          });
        }
      }

      const archive: ArchivedSubgraph = {
        entity_id: entity.id,
        nodes,
        edges,
        archived_at: now,
      };

      // Serialize to JSON — convert Float32Array to regular arrays for storage
      const serialized = JSON.stringify(archive, (_key, value) => {
        if (value instanceof Float32Array) {
          return { __type: 'Float32Array', data: Array.from(value) };
        }
        return value;
      });

      if (!cfg.dry_run) {
        // Store in object store
        await this.objectStore.put(Buffer.from(serialized, 'utf-8'), {
          prefix: 'archived-subgraphs',
          extension: `.${entity.id}.json`,
        });

        // Remove nodes and edges from the live graph
        for (const edge of edges) {
          try {
            this.graph.deleteEdge(edge.id);
          } catch {
            // Edge may already be deleted
          }
        }
        for (const node of nodes) {
          try {
            this.graph.deleteNode(node.id);
          } catch {
            // Node may already be deleted
          }
        }
      }

      result.archived_count++;
      result.archived_subgraph_ids.push(entity.id);
    }

    return result;
  }

  async restore(entityId: string): Promise<boolean> {
    // Attempt to read the archived subgraph from the object store
    // The reference uses a known prefix pattern
    let data: Buffer;
    try {
      // We need to find the archive by entity ID — scan known prefix
      const ref = `archived-subgraphs/${entityId}`;
      // The object store uses UUID-based names, so we stored with extension containing entity id
      // Try reading with the entity-based key
      const exists = await this.objectStore.exists(ref);
      if (!exists) {
        return false;
      }
      data = await this.objectStore.get(ref);
    } catch {
      return false;
    }

    const archive: ArchivedSubgraph = JSON.parse(data.toString('utf-8'), (_key, value) => {
      if (value && typeof value === 'object' && value.__type === 'Float32Array') {
        return new Float32Array(value.data);
      }
      return value;
    });

    // Re-insert nodes into the live graph
    for (const node of archive.nodes) {
      const existing = this.graph.getNode(node.id);
      if (!existing) {
        this.graph.addNode(node);
      }
    }

    // Re-insert edges into the live graph
    for (const edge of archive.edges) {
      const existing = this.graph.getEdge(edge.id);
      if (!existing) {
        this.graph.addEdge(edge);
      }
    }

    // Clean up the archived file
    try {
      await this.objectStore.delete(`archived-subgraphs/${entityId}`);
    } catch {
      // Best effort cleanup
    }

    return true;
  }
}
