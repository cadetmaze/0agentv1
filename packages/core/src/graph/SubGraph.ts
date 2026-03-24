import { GraphNode } from './GraphNode.js';
import { GraphEdge } from './GraphEdge.js';

export class SubGraph {
  readonly id: string;
  readonly rootEntityId: string;
  private nodes: Map<string, GraphNode>;
  private edges: Map<string, GraphEdge>;

  constructor(id: string, rootEntityId: string) {
    this.id = id;
    this.rootEntityId = rootEntityId;
    this.nodes = new Map();
    this.edges = new Map();
  }

  addNode(node: GraphNode): void {
    this.nodes.set(node.id, node);
  }

  addEdge(edge: GraphEdge): void {
    this.edges.set(edge.id, edge);
  }

  getNode(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  getEdge(id: string): GraphEdge | undefined {
    return this.edges.get(id);
  }

  /** Remove a node and all edges connected to it. */
  removeNode(id: string): void {
    this.nodes.delete(id);
    for (const [edgeId, edge] of this.edges) {
      if (edge.from_node === id || edge.to_node === id) {
        this.edges.delete(edgeId);
      }
    }
  }

  removeEdge(id: string): void {
    this.edges.delete(id);
  }

  getNodes(): GraphNode[] {
    return Array.from(this.nodes.values());
  }

  getEdges(): GraphEdge[] {
    return Array.from(this.edges.values());
  }

  getEdgesFrom(nodeId: string): GraphEdge[] {
    const result: GraphEdge[] = [];
    for (const edge of this.edges.values()) {
      if (edge.from_node === nodeId) {
        result.push(edge);
      }
    }
    return result;
  }

  getEdgesTo(nodeId: string): GraphEdge[] {
    const result: GraphEdge[] = [];
    for (const edge of this.edges.values()) {
      if (edge.to_node === nodeId) {
        result.push(edge);
      }
    }
    return result;
  }

  get nodeCount(): number {
    return this.nodes.size;
  }

  get edgeCount(): number {
    return this.edges.size;
  }

  /** Serialize to a plain object for snapshot injection into subagents. */
  toSnapshot(): { id: string; rootEntityId: string; nodes: GraphNode[]; edges: GraphEdge[] } {
    return {
      id: this.id,
      rootEntityId: this.rootEntityId,
      nodes: this.getNodes(),
      edges: this.getEdges(),
    };
  }

  static fromSnapshot(snapshot: { id: string; rootEntityId: string; nodes: GraphNode[]; edges: GraphEdge[] }): SubGraph {
    const sg = new SubGraph(snapshot.id, snapshot.rootEntityId);
    for (const node of snapshot.nodes) {
      sg.addNode(node);
    }
    for (const edge of snapshot.edges) {
      sg.addEdge(edge);
    }
    return sg;
  }
}
