import { describe, it, expect, beforeEach } from 'vitest';
import { StagedMutationStore } from '../../../packages/core/src/bootstrap/StagedMutations';
import { GraphConstructor, type ILLMClient, type BootstrapProposal } from '../../../packages/core/src/bootstrap/GraphConstructor';
import { NodeType } from '../../../packages/core/src/graph/GraphNode';
import { EdgeType } from '../../../packages/core/src/graph/GraphEdge';

describe('GraphConstructor', () => {
  let mutations: StagedMutationStore;
  let mockLLM: ILLMClient;
  let constructor_: GraphConstructor;

  const VALID_RESPONSE = `CONTEXT: E-commerce platform optimization
STRATEGY: Caching strategy
PLAN: Analyze traffic patterns | Implement Redis cache | Deploy CDN
EXPECTED_OUTCOME: 50% reduction in page load time`;

  beforeEach(() => {
    mutations = new StagedMutationStore();
    mockLLM = {
      complete: async (_prompt: string) => VALID_RESPONSE,
    };
    constructor_ = new GraphConstructor(mockLLM, mutations);
  });

  // ── parseResponse ──────────────────────────

  it('parseResponse: valid format returns BootstrapProposal', () => {
    const proposal = constructor_.parseResponse(VALID_RESPONSE);

    expect(proposal).not.toBeNull();
    expect(proposal!.context).toBe('E-commerce platform optimization');
    expect(proposal!.strategy).toBe('Caching strategy');
    expect(proposal!.steps).toEqual(['Analyze traffic patterns', 'Implement Redis cache', 'Deploy CDN']);
    expect(proposal!.expected_outcome).toBe('50% reduction in page load time');
  });

  it('parseResponse: missing field returns null', () => {
    const incomplete = `CONTEXT: Some context
STRATEGY: Some strategy
PLAN: Step 1 | Step 2`;
    // Missing EXPECTED_OUTCOME

    const proposal = constructor_.parseResponse(incomplete);
    expect(proposal).toBeNull();
  });

  it('parseResponse: empty PLAN returns null', () => {
    const noPlan = `CONTEXT: Some context
STRATEGY: Some strategy
PLAN:
EXPECTED_OUTCOME: Some outcome`;

    const proposal = constructor_.parseResponse(noPlan);
    expect(proposal).toBeNull();
  });

  // ── buildGraph ─────────────────────────────

  it('buildGraph: creates correct nodes (1 CONTEXT, 1 STRATEGY, N STEPS, 1 OUTCOME) and edges', () => {
    const proposal: BootstrapProposal = {
      context: 'Test Context',
      strategy: 'Test Strategy',
      steps: ['Step 1', 'Step 2', 'Step 3'],
      expected_outcome: 'Test Outcome',
    };

    const { nodes, edges } = constructor_.buildGraph(proposal, 'test-graph');

    // 1 CONTEXT + 1 STRATEGY + 3 STEPS + 1 OUTCOME = 6 nodes
    expect(nodes).toHaveLength(6);

    const contextNodes = nodes.filter((n) => n.type === NodeType.CONTEXT);
    const strategyNodes = nodes.filter((n) => n.type === NodeType.STRATEGY);
    const stepNodes = nodes.filter((n) => n.type === NodeType.STEP);
    const outcomeNodes = nodes.filter((n) => n.type === NodeType.OUTCOME);

    expect(contextNodes).toHaveLength(1);
    expect(strategyNodes).toHaveLength(1);
    expect(stepNodes).toHaveLength(3);
    expect(outcomeNodes).toHaveLength(1);

    // Check labels
    expect(contextNodes[0].label).toBe('Test Context');
    expect(strategyNodes[0].label).toBe('Test Strategy');
    expect(stepNodes.map((n) => n.label)).toEqual(['Step 1', 'Step 2', 'Step 3']);
    expect(outcomeNodes[0].label).toBe('Test Outcome');

    // All nodes belong to the correct graph
    for (const n of nodes) {
      expect(n.graph_id).toBe('test-graph');
    }

    // Edges:
    // 1 SUPPORTS (CONTEXT -> STRATEGY)
    // 3 LEADS_TO (STRATEGY -> each STEP)
    // 1 PRODUCES (last STEP -> OUTCOME)
    // Total: 5 edges
    expect(edges).toHaveLength(5);

    const supportsEdges = edges.filter((e) => e.type === EdgeType.SUPPORTS);
    const leadsToEdges = edges.filter((e) => e.type === EdgeType.LEADS_TO);
    const producesEdges = edges.filter((e) => e.type === EdgeType.PRODUCES);

    expect(supportsEdges).toHaveLength(1);
    expect(leadsToEdges).toHaveLength(3);
    expect(producesEdges).toHaveLength(1);

    // CONTEXT -> STRATEGY
    expect(supportsEdges[0].from_node).toBe(contextNodes[0].id);
    expect(supportsEdges[0].to_node).toBe(strategyNodes[0].id);

    // Last step -> OUTCOME
    expect(producesEdges[0].from_node).toBe(stepNodes[2].id);
    expect(producesEdges[0].to_node).toBe(outcomeNodes[0].id);
  });

  // ── propose (integration with mock LLM) ───

  it('propose: integration with mock LLM returns mutation id', async () => {
    const mutationId = await constructor_.propose('Optimize e-commerce site', 'trace-1', 'root');

    expect(mutationId).not.toBeNull();
    expect(typeof mutationId).toBe('string');

    // Mutation should be staged
    const mutation = mutations.get(mutationId!);
    expect(mutation).not.toBeNull();
    expect(mutation!.trace_id).toBe('trace-1');
    expect(mutation!.committed).toBe(false);
    expect(mutation!.proposed_nodes).toHaveLength(6); // 1 context + 1 strategy + 3 steps + 1 outcome
    expect(mutation!.proposed_edges).toHaveLength(5);
  });

  it('propose: returns null when LLM returns unparseable response', async () => {
    const badLLM: ILLMClient = {
      complete: async () => 'This is not a valid response format at all.',
    };
    const badConstructor = new GraphConstructor(badLLM, mutations);

    const result = await badConstructor.propose('Some task', 'trace-2');
    expect(result).toBeNull();
  });
});
