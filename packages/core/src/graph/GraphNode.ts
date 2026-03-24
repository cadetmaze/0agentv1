export enum NodeType {
  ENTITY       = "entity",
  CONTEXT      = "context",
  STRATEGY     = "strategy",
  PLAN         = "plan",
  STEP         = "step",
  OUTCOME      = "outcome",
  SIGNAL       = "signal",
  TOOL         = "tool",
  CONSTRAINT   = "constraint",
  HYPOTHESIS   = "hypothesis",
}

export enum ContentType {
  TEXT       = "text",
  IMAGE      = "image",
  CODE       = "code",
  STRUCTURED = "structured",
  AUDIO      = "audio",
}

export interface NodeContent {
  id: string;
  node_id: string;
  type: ContentType;
  data: string;
  metadata: Record<string, unknown>;
}

export interface GraphNode {
  id: string;
  graph_id: string;
  label: string;
  type: NodeType;
  created_at: number;
  last_seen: number;
  visit_count: number;
  metadata: Record<string, unknown>;
  subgraph_id: string | null;
  embedding: Float32Array | null;
  embedding_model: string | null;
  embedding_at: number | null;
  content: NodeContent[];
}

/** Factory function to create a new node with sensible defaults. */
export function createNode(params: {
  id: string;
  graph_id: string;
  label: string;
  type: NodeType;
  metadata?: Record<string, unknown>;
  subgraph_id?: string | null;
  content?: NodeContent[];
}): GraphNode {
  const now = Date.now();
  return {
    id: params.id,
    graph_id: params.graph_id,
    label: params.label,
    type: params.type,
    created_at: now,
    last_seen: now,
    visit_count: 1,
    metadata: params.metadata ?? {},
    subgraph_id: params.subgraph_id ?? null,
    embedding: null,
    embedding_model: null,
    embedding_at: null,
    content: params.content ?? [],
  };
}
