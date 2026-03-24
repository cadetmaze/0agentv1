import { NodeType, ContentType, createNode, type GraphNode } from '../graph/GraphNode.js';
import { EdgeType, createEdge } from '../graph/GraphEdge.js';
import type { KnowledgeGraph } from '../graph/KnowledgeGraph.js';

export interface PersonalityProfile {
  entity_id: string;
  communication_style: string;     // e.g. "direct, bullet-points, no preamble"
  response_preferences: string[];  // e.g. ["lead with numbers", "no emojis", "skip small talk"]
  working_context: string;         // e.g. "debugging auth latency, sprint ends Friday"
  expertise_areas: string[];       // e.g. ["TypeScript", "distributed systems"]
  timezone: string;                // e.g. "America/Los_Angeles"
  interaction_count: number;       // how many times the agent has interacted
  last_interaction: number;        // timestamp
  raw_signals: string[];           // recent raw observations, max 20
}

export const PERSONALITY_NODE_LABEL = '__personality_profile__';

export class PersonalityProfileStore {
  constructor(private graph: KnowledgeGraph) {}

  /**
   * Get the personality profile for an entity.
   * Returns null if no profile exists yet.
   */
  get(entityId: string): PersonalityProfile | null {
    // Profile node is connected to entity via PRODUCES edge — BFS at depth 1 finds it
    const subgraph = this.graph.getSubGraph(entityId, 1);
    const profileNode = subgraph.getNodes().find(
      (n: GraphNode) => n.label === PERSONALITY_NODE_LABEL && n.metadata?.entity_id === entityId,
    );
    if (!profileNode) return null;

    const content = profileNode.content[0];
    if (!content) return null;

    try {
      return JSON.parse(content.data) as PersonalityProfile;
    } catch {
      return null;
    }
  }

  /**
   * Create or update the personality profile for an entity.
   */
  set(entityId: string, profile: PersonalityProfile): void {
    const subgraph = this.graph.getSubGraph(entityId, 1);
    const existing = subgraph.getNodes().find(
      (n: GraphNode) => n.label === PERSONALITY_NODE_LABEL && n.metadata?.entity_id === entityId,
    );
    // Also clean up the PRODUCES edge to the old profile node
    if (existing) {
      const edges = this.graph.getEdgesFrom(entityId).filter(e => e.to_node === existing.id);
      for (const e of edges) this.graph.deleteEdge(e.id);
    }

    if (existing) {
      // Update: delete + re-insert node with new content (simplest approach for now)
      this.graph.deleteNode(existing.id);
    }

    const contentId = crypto.randomUUID();
    const profileData = JSON.stringify(profile);

    const profileNode = createNode({
      id: crypto.randomUUID(),
      graph_id: subgraph.rootEntityId,  // scoped to entity's graph
      label: PERSONALITY_NODE_LABEL,
      type: NodeType.SIGNAL,
      subgraph_id: entityId,
      metadata: {
        entity_id: entityId,
        is_personality_profile: true,
      },
      content: [{
        id: contentId,
        node_id: '',  // filled in after creation
        type: ContentType.STRUCTURED,
        data: profileData,
        metadata: { schema: 'PersonalityProfile' },
      }],
    });
    profileNode.content[0].node_id = profileNode.id;

    this.graph.addNode(profileNode);
    // Connect entity → profile with PRODUCES edge so BFS finds it at depth 1
    const edge = createEdge({
      id: crypto.randomUUID(),
      graph_id: 'root',
      from_node: entityId,
      to_node: profileNode.id,
      type: EdgeType.PRODUCES,
    });
    this.graph.addEdge(edge);
  }

  /**
   * Create a default blank profile for a new entity.
   */
  createDefault(entityId: string, _entityLabel: string): PersonalityProfile {
    return {
      entity_id: entityId,
      communication_style: 'unknown — learning from interactions',
      response_preferences: [],
      working_context: '',
      expertise_areas: [],
      timezone: 'UTC',
      interaction_count: 0,
      last_interaction: Date.now(),
      raw_signals: [],
    };
  }
}
