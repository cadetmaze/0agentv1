import { EdgeType } from './GraphEdge.js';
import { NodeType, GraphNode } from './GraphNode.js';

export interface StructuralQueryOpts {
  graph_id?: string;
  from_node?: string;
  to_node?: string;
  edge_type?: EdgeType;
  node_type?: NodeType;
  min_weight?: number;
  max_weight?: number;
  limit?: number;
  order_by?: 'weight_desc' | 'weight_asc' | 'created_at_desc' | 'traversal_count_desc';
}

export interface SemanticQueryOpts {
  embedding: Float32Array;
  node_types?: NodeType[];
  limit?: number;
  min_similarity?: number;
}

export interface MergedQueryOpts {
  structural: StructuralQueryOpts;
  semantic?: SemanticQueryOpts;
  semantic_weight?: number;   // default 0.4
  structural_weight?: number; // default 0.6
  limit?: number;
}

export interface QueryResult {
  node: GraphNode;
  score: number;
  source: 'structural' | 'semantic' | 'merged';
}

/**
 * GraphQuery is a builder that holds query options.
 * Actual execution happens in KnowledgeGraph.
 */
export class GraphQuery {
  private opts: MergedQueryOpts;

  private constructor(opts: MergedQueryOpts) {
    this.opts = opts;
  }

  static structural(opts: StructuralQueryOpts): GraphQuery {
    return new GraphQuery({
      structural: opts,
      structural_weight: 1.0,
      semantic_weight: 0.0,
    });
  }

  static semantic(opts: SemanticQueryOpts): GraphQuery {
    return new GraphQuery({
      structural: {},
      semantic: opts,
      structural_weight: 0.0,
      semantic_weight: 1.0,
      limit: opts.limit,
    });
  }

  static merged(opts: MergedQueryOpts): GraphQuery {
    return new GraphQuery({
      ...opts,
      structural_weight: opts.structural_weight ?? 0.6,
      semantic_weight: opts.semantic_weight ?? 0.4,
    });
  }

  getStructuralOpts(): StructuralQueryOpts | undefined {
    const w = this.opts.structural_weight ?? 0.6;
    if (w === 0 && !this.opts.structural.from_node && !this.opts.structural.to_node) {
      return undefined;
    }
    return this.opts.structural;
  }

  getSemanticOpts(): SemanticQueryOpts | undefined {
    return this.opts.semantic;
  }

  getMergedOpts(): MergedQueryOpts {
    return this.opts;
  }
}
