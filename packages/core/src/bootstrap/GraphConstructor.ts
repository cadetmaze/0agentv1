import {
  createNode,
  NodeType,
  ContentType,
  type GraphNode,
} from '../graph/GraphNode.js';
import { createEdge, EdgeType, type GraphEdge } from '../graph/GraphEdge.js';
import type { StagedMutationStore } from './StagedMutations.js';

/**
 * Minimal LLM interface -- injectable for testing.
 */
export interface ILLMClient {
  complete(prompt: string): Promise<string>;
}

export interface BootstrapProposal {
  context: string;
  strategy: string;
  steps: string[];
  expected_outcome: string;
}

const BOOTSTRAP_PROMPT = `Analyze the following task and produce a structured knowledge graph proposal.

Task: {task}

Respond ONLY in this exact format (one item per line):
CONTEXT: <brief description of the domain context>
STRATEGY: <high-level strategy name>
PLAN: <step 1> | <step 2> | <step 3>
EXPECTED_OUTCOME: <what success looks like>`;

export class GraphConstructor {
  constructor(
    private llm: ILLMClient,
    private mutations: StagedMutationStore,
  ) {}

  /**
   * Parse LLM response into a BootstrapProposal.
   */
  parseResponse(response: string): BootstrapProposal | null {
    const lines = response.trim().split('\n');
    let context = '';
    let strategy = '';
    let steps: string[] = [];
    let expected_outcome = '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('CONTEXT:')) {
        context = trimmed.slice('CONTEXT:'.length).trim();
      } else if (trimmed.startsWith('STRATEGY:')) {
        strategy = trimmed.slice('STRATEGY:'.length).trim();
      } else if (trimmed.startsWith('PLAN:')) {
        const planStr = trimmed.slice('PLAN:'.length).trim();
        steps = planStr
          .split('|')
          .map((s) => s.trim())
          .filter(Boolean);
      } else if (trimmed.startsWith('EXPECTED_OUTCOME:')) {
        expected_outcome = trimmed.slice('EXPECTED_OUTCOME:'.length).trim();
      }
    }

    if (!context || !strategy || steps.length === 0 || !expected_outcome) {
      return null;
    }

    return { context, strategy, steps, expected_outcome };
  }

  /**
   * Generate a graph proposal from a task.
   * Returns the StagedMutation ID, or null if parsing failed.
   */
  async propose(
    task: string,
    traceId: string,
    graphId: string = 'root',
  ): Promise<string | null> {
    const prompt = BOOTSTRAP_PROMPT.replace('{task}', task);
    const response = await this.llm.complete(prompt);
    const proposal = this.parseResponse(response);
    if (!proposal) return null;

    const { nodes, edges } = this.buildGraph(proposal, graphId);

    const mutation = this.mutations.stage({
      id: crypto.randomUUID(),
      trace_id: traceId,
      proposed_nodes: nodes,
      proposed_edges: edges,
    });

    return mutation.id;
  }

  /**
   * Build graph nodes and edges from a bootstrap proposal.
   * Creates:
   * - 1 CONTEXT node
   * - 1 STRATEGY node
   * - N STEP nodes
   * - 1 OUTCOME node
   * Edges: CONTEXT -SUPPORTS-> STRATEGY, STRATEGY -LEADS_TO-> each STEP,
   *        last STEP -PRODUCES-> OUTCOME
   */
  buildGraph(
    proposal: BootstrapProposal,
    graphId: string,
  ): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];

    // Context node
    const contextNodeId = crypto.randomUUID();
    const contentId = crypto.randomUUID();
    const contextNode = createNode({
      id: contextNodeId,
      graph_id: graphId,
      label: proposal.context,
      type: NodeType.CONTEXT,
      content: [
        {
          id: contentId,
          node_id: contextNodeId,
          type: ContentType.TEXT,
          data: proposal.context,
          metadata: {},
        },
      ],
    });
    nodes.push(contextNode);

    // Strategy node
    const strategyNode = createNode({
      id: crypto.randomUUID(),
      graph_id: graphId,
      label: proposal.strategy,
      type: NodeType.STRATEGY,
    });
    nodes.push(strategyNode);

    // CONTEXT -SUPPORTS-> STRATEGY
    edges.push(
      createEdge({
        id: crypto.randomUUID(),
        graph_id: graphId,
        from_node: contextNode.id,
        to_node: strategyNode.id,
        type: EdgeType.SUPPORTS,
      }),
    );

    // Step nodes
    const stepNodes: GraphNode[] = [];
    for (const stepText of proposal.steps) {
      const stepNode = createNode({
        id: crypto.randomUUID(),
        graph_id: graphId,
        label: stepText,
        type: NodeType.STEP,
      });
      stepNodes.push(stepNode);
      nodes.push(stepNode);

      // STRATEGY -LEADS_TO-> STEP
      edges.push(
        createEdge({
          id: crypto.randomUUID(),
          graph_id: graphId,
          from_node: strategyNode.id,
          to_node: stepNode.id,
          type: EdgeType.LEADS_TO,
        }),
      );
    }

    // Outcome node
    const outcomeNode = createNode({
      id: crypto.randomUUID(),
      graph_id: graphId,
      label: proposal.expected_outcome,
      type: NodeType.OUTCOME,
    });
    nodes.push(outcomeNode);

    // Last step -PRODUCES-> OUTCOME
    if (stepNodes.length > 0) {
      edges.push(
        createEdge({
          id: crypto.randomUUID(),
          graph_id: graphId,
          from_node: stepNodes[stepNodes.length - 1].id,
          to_node: outcomeNode.id,
          type: EdgeType.PRODUCES,
        }),
      );
    }

    return { nodes, edges };
  }
}
