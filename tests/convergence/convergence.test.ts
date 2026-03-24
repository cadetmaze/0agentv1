import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SQLiteAdapter } from '../../packages/core/src/storage/adapters/SQLiteAdapter.js';
import { WeightEventLog } from '../../packages/core/src/storage/WeightEventLog.js';
import { KnowledgeGraph } from '../../packages/core/src/graph/KnowledgeGraph.js';
import { createNode, NodeType } from '../../packages/core/src/graph/GraphNode.js';
import { createEdge, EdgeType } from '../../packages/core/src/graph/GraphEdge.js';
import { WeightPropagation, StepLedger, OutcomeSignal } from '../../packages/core/src/engine/WeightPropagation.js';
import { SelectionPolicy } from '../../packages/core/src/engine/SelectionPolicy.js';
import { EdgeWeightUpdater } from '../../packages/core/src/concurrency/EdgeWeightUpdater.js';

// ---------------------------------------------------------------------------
// Deterministic seeded PRNG (LCG)
// ---------------------------------------------------------------------------
function seededRng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}

// ---------------------------------------------------------------------------
// Ground-truth success probabilities
// ---------------------------------------------------------------------------
const GROUND_TRUTH: Record<string, number> = {
  founder_pitch: 0.8,
  champion_route: 0.3,
  product_led: 0.5,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const GRAPH_ID = 'test-graph';

interface TestHarness {
  adapter: SQLiteAdapter;
  graph: KnowledgeGraph;
  propagation: WeightPropagation;
  policy: SelectionPolicy;
  rng: () => number;
  edgeIds: Record<string, string>; // strategy label -> edge id
  contextNodeId: string;
}

function buildHarness(opts: {
  seed: number;
  epsilon?: number;
  initialWeights?: Record<string, number>;
}): TestHarness {
  const rng = seededRng(opts.seed);

  const adapter = new SQLiteAdapter({ db_path: ':memory:' });
  const weightLog = new WeightEventLog(adapter);
  const graph = new KnowledgeGraph(adapter);
  const updater = new EdgeWeightUpdater(adapter, weightLog);
  const propagation = new WeightPropagation(graph, updater, { learning_rate: 0.1 });
  const policy = new SelectionPolicy(
    { epsilon: opts.epsilon ?? 0.15, temperature: 0.5 },
    rng,
  );

  // -- Nodes --
  const contextNode = createNode({
    id: 'ctx-cold-outbound',
    graph_id: GRAPH_ID,
    label: 'cold_outbound',
    type: NodeType.CONTEXT,
  });
  graph.addNode(contextNode);

  const strategyLabels = ['founder_pitch', 'champion_route', 'product_led'];
  const edgeIds: Record<string, string> = {};

  for (const label of strategyLabels) {
    const nodeId = `strat-${label}`;
    const stratNode = createNode({
      id: nodeId,
      graph_id: GRAPH_ID,
      label,
      type: NodeType.STRATEGY,
    });
    graph.addNode(stratNode);

    const edgeId = `edge-${label}`;
    const weight = opts.initialWeights?.[label] ?? 0.5;
    const edge = createEdge({
      id: edgeId,
      graph_id: GRAPH_ID,
      from_node: contextNode.id,
      to_node: nodeId,
      type: EdgeType.LEADS_TO,
      weight,
    });
    graph.addEdge(edge);
    edgeIds[label] = edgeId;
  }

  return {
    adapter,
    graph,
    propagation,
    policy,
    rng,
    edgeIds,
    contextNodeId: contextNode.id,
  };
}

/**
 * Run N traces through the simulated environment.
 * Each trace: select a strategy, simulate an outcome, propagate the signal.
 */
async function runTraces(h: TestHarness, n: number): Promise<Set<string>> {
  const selectedStrategies = new Set<string>();

  for (let i = 0; i < n; i++) {
    // Get current candidate edges from the context node
    const candidates = h.graph.getEdgesFrom(h.contextNodeId);

    // Select a strategy via epsilon-greedy
    const selection = h.policy.select(candidates);
    if (!selection) throw new Error('No selection returned');

    const edge = selection.edge;
    const strategyLabel = h.graph.getNode(edge.to_node)!.label;
    selectedStrategies.add(strategyLabel);

    // Simulate outcome based on ground-truth probability
    const successProb = GROUND_TRUTH[strategyLabel];
    const roll = h.rng();
    const success = roll < successProb;
    const outcomeValue = success ? 1.0 : -1.0;

    const traceId = `trace-${i}`;

    // Build step ledger (single step per trace)
    const step: StepLedger = {
      edge_id: edge.id,
      step_index: 0,
      has_sub_outcome: false,
      weight_at_traversal: edge.weight,
    };

    const outcome: OutcomeSignal = {
      value: outcomeValue,
      type: 'explicit',
      trace_id: traceId,
      resolved_at: Date.now(),
    };

    // Propagate the signal
    await h.propagation.propagate([step], outcome);
  }

  return selectedStrategies;
}

function getWeight(h: TestHarness, strategyLabel: string): number {
  const edge = h.graph.getEdge(h.edgeIds[strategyLabel]);
  if (!edge) throw new Error(`Edge not found for ${strategyLabel}`);
  return edge.weight;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('Convergence', () => {
  let harness: TestHarness;

  afterEach(() => {
    harness?.adapter?.close();
  });

  it('converges to optimal strategy in 50 traces', async () => {
    harness = buildHarness({ seed: 42 });

    await runTraces(harness, 50);

    const founderWeight = getWeight(harness, 'founder_pitch');
    const championWeight = getWeight(harness, 'champion_route');
    const productWeight = getWeight(harness, 'product_led');

    // founder_pitch (P=0.8) should clearly dominate
    expect(founderWeight).toBeGreaterThan(0.7);
    // champion_route (P=0.3) should have fallen below neutral
    expect(championWeight).toBeLessThan(0.5);

    // Sanity: founder_pitch should be the highest weight
    expect(founderWeight).toBeGreaterThan(productWeight);
    expect(founderWeight).toBeGreaterThan(championWeight);
  }, 30_000);

  it('recovers from early bad luck in 30 traces', async () => {
    // Start with champion_route artificially boosted and founder_pitch suppressed
    harness = buildHarness({
      seed: 77,
      initialWeights: {
        founder_pitch: 0.3,
        champion_route: 0.7,
        product_led: 0.5,
      },
    });

    await runTraces(harness, 30);

    const founderWeight = getWeight(harness, 'founder_pitch');
    const championWeight = getWeight(harness, 'champion_route');

    // founder_pitch (P=0.8) should have recovered past champion_route (P=0.3)
    expect(founderWeight).toBeGreaterThan(championWeight);
  }, 30_000);

  it('exploration prevents premature convergence', async () => {
    harness = buildHarness({ seed: 123, epsilon: 0.15 });

    const selectedStrategies = await runTraces(harness, 50);

    // With epsilon=0.15, over 50 traces even the worst strategy
    // should be selected at least once via exploration
    expect(selectedStrategies.has('founder_pitch')).toBe(true);
    expect(selectedStrategies.has('champion_route')).toBe(true);
    expect(selectedStrategies.has('product_led')).toBe(true);
  }, 30_000);
});
