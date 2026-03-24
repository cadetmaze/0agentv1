import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SQLiteAdapter } from '../../../packages/core/src/storage/adapters/SQLiteAdapter';
import { KnowledgeGraph } from '../../../packages/core/src/graph/KnowledgeGraph';
import { WeightEventLog } from '../../../packages/core/src/storage/WeightEventLog';
import { EdgeWeightUpdater } from '../../../packages/core/src/concurrency/EdgeWeightUpdater';
import { WeightPropagation, type StepLedger, type OutcomeSignal } from '../../../packages/core/src/engine/WeightPropagation';
import { createNode, NodeType } from '../../../packages/core/src/graph/GraphNode';
import { createEdge, EdgeType, type GraphEdge } from '../../../packages/core/src/graph/GraphEdge';

describe('WeightPropagation', () => {
  let adapter: SQLiteAdapter;
  let graph: KnowledgeGraph;
  let updater: EdgeWeightUpdater;
  let wp: WeightPropagation;

  beforeEach(() => {
    adapter = new SQLiteAdapter({ db_path: ':memory:' });
    graph = new KnowledgeGraph(adapter);
    const weightLog = new WeightEventLog(adapter);
    updater = new EdgeWeightUpdater(adapter, weightLog);
    wp = new WeightPropagation(graph, updater);
  });

  afterEach(() => {
    adapter.close();
  });

  // ── computeInfluence ───────────────────────

  it('computeInfluence: no competitors returns 1.0', () => {
    const edge = createEdge({ id: 'e1', graph_id: 'g1', from_node: 'a', to_node: 'b', type: EdgeType.LEADS_TO, weight: 0.7 });
    expect(wp.computeInfluence(edge, [])).toBe(1.0);
  });

  it('computeInfluence: with competitors uses margin-based scoring (NOT raw proportion)', () => {
    const edge = createEdge({ id: 'e1', graph_id: 'g1', from_node: 'a', to_node: 'b', type: EdgeType.LEADS_TO, weight: 0.8 });
    const comp1 = createEdge({ id: 'e2', graph_id: 'g1', from_node: 'a', to_node: 'c', type: EdgeType.LEADS_TO, weight: 0.6 });
    const comp2 = createEdge({ id: 'e3', graph_id: 'g1', from_node: 'a', to_node: 'd', type: EdgeType.LEADS_TO, weight: 0.4 });

    const influence = wp.computeInfluence(edge, [comp1, comp2]);
    // margin = 0.8 - 0.6 = 0.2, rawInfluence = max(0.1, 0.2/0.8) = 0.25
    // minInfluence = 1/(2+1) = 0.333...
    // influence = max(0.333, 0.25) = 0.333...
    expect(influence).toBeCloseTo(1 / 3, 5);

    // Verify it's NOT raw proportion (0.8 / (0.8+0.6+0.4) = 0.444)
    expect(influence).not.toBeCloseTo(0.444, 2);
  });

  it('computeInfluence: floor is 1/(N+1)', () => {
    // Edge with lower weight than competitors -- margin negative, rawInfluence gets floored at 0.1
    // Then minInfluence = 1/(N+1) should kick in
    const edge = createEdge({ id: 'e1', graph_id: 'g1', from_node: 'a', to_node: 'b', type: EdgeType.LEADS_TO, weight: 0.3 });
    const comp1 = createEdge({ id: 'e2', graph_id: 'g1', from_node: 'a', to_node: 'c', type: EdgeType.LEADS_TO, weight: 0.9 });
    const comp2 = createEdge({ id: 'e3', graph_id: 'g1', from_node: 'a', to_node: 'd', type: EdgeType.LEADS_TO, weight: 0.8 });

    const influence = wp.computeInfluence(edge, [comp1, comp2]);
    // margin = 0.3 - 0.9 = -0.6, rawInfluence = max(0.1, -0.6/0.3) = max(0.1, -2) = 0.1
    // minInfluence = 1/(2+1) = 0.333
    // influence = max(0.333, 0.1) = 0.333
    expect(influence).toBeCloseTo(1 / 3, 5);
  });

  // ── computeDiscount ────────────────────────

  it('computeDiscount: step 0 returns 1.0', () => {
    const step: StepLedger = { edge_id: 'e1', step_index: 0, has_sub_outcome: false, weight_at_traversal: 0.5 };
    expect(wp.computeDiscount(step)).toBe(1.0);
  });

  it('computeDiscount: step 3 returns 0.85^3', () => {
    const step: StepLedger = { edge_id: 'e1', step_index: 3, has_sub_outcome: false, weight_at_traversal: 0.5 };
    expect(wp.computeDiscount(step)).toBeCloseTo(Math.pow(0.85, 3), 10);
  });

  it('computeDiscount: has_sub_outcome halves the discount', () => {
    const step: StepLedger = { edge_id: 'e1', step_index: 2, has_sub_outcome: true, weight_at_traversal: 0.5 };
    const expected = Math.pow(0.85, 2) * 0.5;
    expect(wp.computeDiscount(step)).toBeCloseTo(expected, 10);
  });

  // ── computeCredit ──────────────────────────

  it('computeCredit: basic multiplication', () => {
    const credit = wp.computeCredit(0.8, 0.5, 0.7);
    expect(credit).toBeCloseTo(0.8 * 0.5 * 0.7, 10);
  });

  // ── applyCredit ────────────────────────────

  it('applyCredit: clamps to [0, 1]', () => {
    // Large positive credit on weight near 1 should clamp to 1
    expect(wp.applyCredit(0.95, 10)).toBe(1.0);
    // Large negative credit on weight near 0 should clamp to 0
    expect(wp.applyCredit(0.05, -10)).toBe(0.0);
  });

  // ── propagate integration ──────────────────

  it('propagate: winner edge gets higher weight after positive outcome', async () => {
    // Setup: source node with two competing edges
    const src = createNode({ id: 'src', graph_id: 'g1', label: 'Source', type: NodeType.CONTEXT });
    const winTarget = createNode({ id: 'win', graph_id: 'g1', label: 'Winner', type: NodeType.STRATEGY });
    const loseTarget = createNode({ id: 'lose', graph_id: 'g1', label: 'Loser', type: NodeType.STRATEGY });
    graph.addNode(src);
    graph.addNode(winTarget);
    graph.addNode(loseTarget);

    graph.addEdge(createEdge({ id: 'e-win', graph_id: 'g1', from_node: 'src', to_node: 'win', type: EdgeType.LEADS_TO, weight: 0.6 }));
    graph.addEdge(createEdge({ id: 'e-lose', graph_id: 'g1', from_node: 'src', to_node: 'lose', type: EdgeType.LEADS_TO, weight: 0.4 }));

    const steps: StepLedger[] = [
      { edge_id: 'e-win', step_index: 0, has_sub_outcome: false, weight_at_traversal: 0.6 },
    ];
    const outcome: OutcomeSignal = { value: 1.0, type: 'explicit', trace_id: 'trace-1', resolved_at: Date.now() };

    const results = await wp.propagate(steps, outcome);

    expect(results).toHaveLength(1);
    expect(results[0].new_weight).toBeGreaterThan(0.6);
    expect(results[0].delta).toBeGreaterThan(0);

    // Verify persisted
    const updatedEdge = graph.getEdge('e-win');
    expect(updatedEdge!.weight).toBeGreaterThan(0.6);
  });

  it('propagate: locked edge is skipped', async () => {
    const src = createNode({ id: 'src', graph_id: 'g1', label: 'Source', type: NodeType.CONTEXT });
    const tgt = createNode({ id: 'tgt', graph_id: 'g1', label: 'Target', type: NodeType.STRATEGY });
    graph.addNode(src);
    graph.addNode(tgt);

    graph.addEdge(createEdge({ id: 'e-locked', graph_id: 'g1', from_node: 'src', to_node: 'tgt', type: EdgeType.LEADS_TO, weight: 0.7, locked: true }));

    const steps: StepLedger[] = [
      { edge_id: 'e-locked', step_index: 0, has_sub_outcome: false, weight_at_traversal: 0.7 },
    ];
    const outcome: OutcomeSignal = { value: 1.0, type: 'explicit', trace_id: 'trace-2', resolved_at: Date.now() };

    const results = await wp.propagate(steps, outcome);
    expect(results).toHaveLength(0);

    // Weight unchanged
    const edge = graph.getEdge('e-locked');
    expect(edge!.weight).toBe(0.7);
  });
});
