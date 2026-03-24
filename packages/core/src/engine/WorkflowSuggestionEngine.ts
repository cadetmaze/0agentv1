/**
 * WorkflowSuggestionEngine — Recommends the next skill based on
 * workflow graph weights.
 *
 * Traverses from a skill node to its outgoing edges targeting other
 * skill nodes, returning the highest-weight successor or ranked options.
 */

import type { KnowledgeGraph } from '../graph/KnowledgeGraph.js';

export class WorkflowSuggestionEngine {
  constructor(private graph: KnowledgeGraph) {}

  /**
   * Suggest the next skill to run based on the current graph state.
   * Finds the skill node, gets outgoing edges to other skill nodes,
   * returns the highest-weight successor.
   */
  suggest(lastSkillName: string): string | null {
    const results = this.graph.queryStructural({ limit: 100 });
    const skillNode = results.find(
      (r) => r.node.label === lastSkillName && r.node.metadata?.is_skill,
    );
    if (!skillNode) return null;

    const edges = this.graph.getEdgesFrom(skillNode.node.id);
    let bestLabel: string | null = null;
    let bestWeight = -1;

    for (const edge of edges) {
      const target = this.graph.getNode(edge.to_node);
      if (target?.metadata?.is_skill && edge.weight > bestWeight) {
        bestWeight = edge.weight;
        bestLabel = target.label;
      }
    }

    return bestLabel;
  }

  /**
   * Get all possible next skills with their weights, sorted descending.
   */
  getNextOptions(lastSkillName: string): Array<{ skill: string; weight: number }> {
    const results = this.graph.queryStructural({ limit: 100 });
    const skillNode = results.find(
      (r) => r.node.label === lastSkillName && r.node.metadata?.is_skill,
    );
    if (!skillNode) return [];

    const edges = this.graph.getEdgesFrom(skillNode.node.id);
    const options: Array<{ skill: string; weight: number }> = [];

    for (const edge of edges) {
      const target = this.graph.getNode(edge.to_node);
      if (target?.metadata?.is_skill) {
        options.push({ skill: target.label, weight: edge.weight });
      }
    }

    return options.sort((a, b) => b.weight - a.weight);
  }
}
