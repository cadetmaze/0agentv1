import { NodeType, ContentType, createNode, type GraphNode } from '../graph/GraphNode.js';
import { EdgeType, createEdge } from '../graph/GraphEdge.js';
import type { KnowledgeGraph } from '../graph/KnowledgeGraph.js';

export interface EntityContext {
  entity: GraphNode;
  personal_subgraph_ids: string[];   // node IDs in entity's own subgraph
  parent_entities: GraphNode[];      // company, team, etc. the entity belongs to
  shared_subgraph_ids: string[];     // node IDs visible from parent entities
  merged_context: GraphNode[];       // personal + allowed shared context combined
}

export interface VisibilityPolicy {
  // What a parent entity (company) can see from a child entity (employee)
  allow_work_context: boolean;        // default true — projects, tasks
  allow_signal_nodes: boolean;        // default true — high-level signals
  allow_personality_profile: boolean; // default false — keep personal
  allow_raw_conversations: boolean;   // default false — never
}

export const DEFAULT_VISIBILITY_POLICY: VisibilityPolicy = {
  allow_work_context: true,
  allow_signal_nodes: true,
  allow_personality_profile: false,
  allow_raw_conversations: false,
};

export class EntityHierarchy {
  constructor(
    private graph: KnowledgeGraph,
    private policy: VisibilityPolicy = DEFAULT_VISIBILITY_POLICY,
  ) {}

  /**
   * Get all parent entities for an entity (via MEMBER_OF edges, forward direction).
   * Sarah is MEMBER_OF Acme Corp → Acme Corp is Sarah's parent.
   */
  getParents(entityId: string): GraphNode[] {
    // MEMBER_OF edge: child → parent (Sarah -MEMBER_OF-> Acme Corp)
    const edges = this.graph.getEdgesFrom(entityId)
      .filter(e => e.type === EdgeType.MEMBER_OF);

    return edges
      .map(e => this.graph.getNode(e.to_node))
      .filter((n): n is GraphNode => n !== null);
  }

  /**
   * Get all child entities (members) of an entity.
   * Acme Corp has MEMBER_OF edges from employees → Acme Corp.
   */
  getMembers(entityId: string): GraphNode[] {
    const edges = this.graph.getEdgesTo(entityId)
      .filter(e => e.type === EdgeType.MEMBER_OF);

    return edges
      .map(e => this.graph.getNode(e.from_node))
      .filter((n): n is GraphNode => n !== null);
  }

  /**
   * Load full entity context for a session:
   * - Person's own subgraph (private, full access)
   * - Parent entities' subgraphs (company — filtered by policy)
   */
  loadEntityContext(entityId: string): EntityContext {
    const entity = this.graph.getNode(entityId);
    if (!entity) throw new Error(`Entity not found: ${entityId}`);

    // Personal subgraph — full access
    const personalSubgraph = this.graph.getSubGraph(entityId, 2);
    const personalNodeIds = personalSubgraph.getNodes().map(n => n.id);

    // Parent entities
    const parents = this.getParents(entityId);
    const sharedNodes: GraphNode[] = [];

    for (const parent of parents) {
      const parentSubgraph = this.graph.getSubGraph(parent.id, 1);
      for (const node of parentSubgraph.getNodes()) {
        if (this.isVisibleToChild(node)) {
          sharedNodes.push(node);
        }
      }
    }

    const sharedNodeIds = sharedNodes.map(n => n.id);
    const merged = [...personalSubgraph.getNodes(), ...sharedNodes];

    return {
      entity,
      personal_subgraph_ids: personalNodeIds,
      parent_entities: parents,
      shared_subgraph_ids: sharedNodeIds,
      merged_context: merged,
    };
  }

  /**
   * What nodes from a parent entity are visible to the child.
   * Applies policy: strategy/plan/context nodes are shared; personality is not.
   */
  private isVisibleToChild(node: GraphNode): boolean {
    // Context, strategy, plan, step nodes = shared work context
    if (
      node.type === NodeType.CONTEXT ||
      node.type === NodeType.STRATEGY ||
      node.type === NodeType.PLAN ||
      node.type === NodeType.STEP
    ) {
      return this.policy.allow_work_context;
    }
    // Signal nodes = high-level signals
    if (node.type === NodeType.SIGNAL) {
      if (node.metadata?.is_personality_profile) return this.policy.allow_personality_profile;
      return this.policy.allow_signal_nodes;
    }
    return false;
  }

  /**
   * Propagate a signal from a child entity UP to parent entities (attenuated).
   * Called after an interaction completes. Company sees "Sarah worked on auth" but not the raw chat.
   */
  propagateSignalUp(
    childEntityId: string,
    signalLabel: string,
    signalData: string,
    attenuation: number = 0.5,
  ): void {
    if (!this.policy.allow_signal_nodes) return;

    const parents = this.getParents(childEntityId);

    for (const parent of parents) {
      const nodeId = crypto.randomUUID();
      const contentId = crypto.randomUUID();

      const signalNode = createNode({
        id: nodeId,
        graph_id: parent.id,
        label: `[from member] ${signalLabel}`,
        type: NodeType.SIGNAL,
        subgraph_id: parent.id,
        metadata: {
          source_entity: childEntityId,
          attenuated: true,
          attenuation_factor: attenuation,
        },
        content: [{
          id: contentId,
          node_id: nodeId,
          type: ContentType.TEXT,
          data: signalData,
          metadata: {},
        }],
      });

      this.graph.addNode(signalNode);
      // Connect parent entity → signal node so BFS finds it
      this.graph.addEdge(createEdge({
        id: crypto.randomUUID(),
        graph_id: 'root',
        from_node: parent.id,
        to_node: signalNode.id,
        type: EdgeType.PRODUCES,
      }));
    }
  }
}
