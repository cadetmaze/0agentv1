/**
 * EntityScopedContext — loads the right graph context when a session is
 * attributed to a specific entity (person).
 */

import { WorkingMemory } from '@0agent/core';
import type { KnowledgeGraph, GraphNode } from '@0agent/core';

export interface ScopedContext {
  entity_id: string;
  entity_label: string;
  entity_type: string;
  personality_prompt: string;      // injected into system prompt
  personal_nodes: GraphNode[];     // the person's own subgraph
  shared_nodes: GraphNode[];       // company/team nodes visible to them
  parent_entity_labels: string[];  // ["Acme Corp", "Mobile Team"]
  working_memory: WorkingMemory;   // pre-seeded with entity's recent nodes
}

export class EntityScopedContextLoader {
  constructor(private graph: KnowledgeGraph) {}

  load(entityId: string): ScopedContext | null {
    const entity = this.graph.getNode(entityId);
    if (!entity) return null;

    // 1. Load personal subgraph (depth 2)
    const personalSubgraph = this.graph.getSubGraph(entityId, 2);
    const personalNodes = personalSubgraph.getNodes();

    // 2. Find parent entities via MEMBER_OF edges (person -MEMBER_OF-> company)
    const memberOfEdges = this.graph.getEdgesFrom(entityId)
      .filter(e => e.type === 'member_of');
    const parents: GraphNode[] = memberOfEdges
      .map(e => this.graph.getNode(e.to_node))
      .filter((n): n is GraphNode => n !== null);

    // 3. Load shared nodes from parents (work context only — no raw conversations)
    const sharedNodes: GraphNode[] = [];
    for (const parent of parents) {
      const parentSubgraph = this.graph.getSubGraph(parent.id, 1);
      for (const node of parentSubgraph.getNodes()) {
        // Only share strategy/plan/context/step nodes from parent
        if (['context', 'strategy', 'plan', 'step'].includes(node.type)) {
          if (!sharedNodes.find(n => n.id === node.id)) {
            sharedNodes.push(node);
          }
        }
      }
    }

    // 4. Extract personality prompt from SIGNAL nodes
    const personalityNode = personalNodes.find(
      n => n.label === '__personality_profile__' && n.metadata?.entity_id === entityId,
    );
    let personalityPrompt = '';
    if (personalityNode?.content[0]) {
      try {
        const profile = JSON.parse(personalityNode.content[0].data) as {
          interaction_count: number;
          communication_style?: string;
          response_preferences?: string[];
          working_context?: string;
          timezone?: string;
        };
        if (profile.interaction_count >= 3) {
          const lines: string[] = [];
          if (profile.communication_style && !profile.communication_style.includes('unknown')) {
            lines.push(`Communication style: ${profile.communication_style}.`);
          }
          if (profile.response_preferences && profile.response_preferences.length > 0) {
            lines.push(`Preferences: ${profile.response_preferences.join(', ')}.`);
          }
          if (profile.working_context) {
            lines.push(`Currently working on: ${profile.working_context}.`);
          }
          if (profile.timezone && profile.timezone !== 'UTC') {
            lines.push(`Timezone: ${profile.timezone}.`);
          }
          if (lines.length > 0) {
            personalityPrompt = [
              `Context about this person (${profile.interaction_count} past interactions):`,
              ...lines,
              'Match their style directly.',
            ].join('\n');
          }
        }
      } catch { /* malformed profile */ }
    }

    // 5. Pre-seed working memory with entity's recent nodes
    const workingMemory = new WorkingMemory(this.graph, { max_nodes: 50 });
    for (const node of personalNodes.slice(-20)) {
      workingMemory.put(node);
    }

    return {
      entity_id: entityId,
      entity_label: entity.label,
      entity_type: entity.type,
      personality_prompt: personalityPrompt,
      personal_nodes: personalNodes,
      shared_nodes: sharedNodes,
      parent_entity_labels: parents.map(p => p.label),
      working_memory: workingMemory,
    };
  }
}
