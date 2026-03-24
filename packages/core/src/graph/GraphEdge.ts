export enum EdgeType {
  LEADS_TO      = "leads_to",
  REQUIRES      = "requires",
  CONTRADICTS   = "contradicts",
  SUPPORTS      = "supports",
  PRODUCES      = "produces",
  MEMBER_OF     = "member_of",
  ALIAS_OF      = "alias_of",
  MIRRORS       = "mirrors",
}

export interface GraphEdge {
  id: string;
  graph_id: string;
  from_node: string;
  to_node: string;
  type: EdgeType;
  weight: number;       // 0.0-1.0, neutral = 0.5
  locked: boolean;
  decay_rate: number;   // default 0.001
  created_at: number;
  last_traversed: number | null;
  traversal_count: number;
  metadata: Record<string, unknown>;
}

/** Factory function to create a new edge with sensible defaults. */
export function createEdge(params: {
  id: string;
  graph_id: string;
  from_node: string;
  to_node: string;
  type: EdgeType;
  weight?: number;
  locked?: boolean;
  decay_rate?: number;
  metadata?: Record<string, unknown>;
}): GraphEdge {
  return {
    id: params.id,
    graph_id: params.graph_id,
    from_node: params.from_node,
    to_node: params.to_node,
    type: params.type,
    weight: params.weight ?? 0.5,
    locked: params.locked ?? false,
    decay_rate: params.decay_rate ?? 0.001,
    created_at: Date.now(),
    last_traversed: null,
    traversal_count: 0,
    metadata: params.metadata ?? {},
  };
}
