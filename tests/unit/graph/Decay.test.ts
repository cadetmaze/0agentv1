import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SQLiteAdapter } from '../../../packages/core/src/storage/adapters/SQLiteAdapter';
import { KnowledgeGraph } from '../../../packages/core/src/graph/KnowledgeGraph';
import { WeightEventLog } from '../../../packages/core/src/storage/WeightEventLog';
import { EdgeWeightUpdater } from '../../../packages/core/src/concurrency/EdgeWeightUpdater';
import { DecayScheduler } from '../../../packages/core/src/engine/DecayScheduler';
import { createNode, NodeType } from '../../../packages/core/src/graph/GraphNode';
import { createEdge, EdgeType, type GraphEdge } from '../../../packages/core/src/graph/GraphEdge';

const HOUR = 60 * 60 * 1000;

describe('DecayScheduler', () => {
  let adapter: SQLiteAdapter;
  let graph: KnowledgeGraph;
  let updater: EdgeWeightUpdater;
  let scheduler: DecayScheduler;

  beforeEach(() => {
    adapter = new SQLiteAdapter({ db_path: ':memory:' });
    graph = new KnowledgeGraph(adapter);
    const weightLog = new WeightEventLog(adapter);
    updater = new EdgeWeightUpdater(adapter, weightLog);
    scheduler = new DecayScheduler(graph, updater);
  });

  afterEach(() => {
    adapter.close();
  });

  function makeEdge(overrides: Partial<GraphEdge> & { id: string; from_node: string; to_node: string }): GraphEdge {
    return {
      graph_id: 'g1',
      type: EdgeType.LEADS_TO as any,
      weight: 0.5,
      locked: false,
      decay_rate: 0.001,
      created_at: Date.now() - 100 * HOUR, // old enough
      last_traversed: null,
      traversal_count: 0,
      metadata: {},
      ...overrides,
    } as GraphEdge;
  }

  it('edge at 0.8 with no traversal for 72h decays toward 0.5', () => {
    const now = Date.now();
    const edge = makeEdge({
      id: 'e1',
      from_node: 'a',
      to_node: 'b',
      weight: 0.8,
      created_at: now - 72 * HOUR,
      last_traversed: now - 72 * HOUR,
    });

    const newWeight = scheduler.decayEdge(edge, now);
    expect(newWeight).not.toBeNull();
    expect(newWeight!).toBeLessThan(0.8);
    expect(newWeight!).toBeGreaterThanOrEqual(0.5);
  });

  it('edge at 0.3 with no traversal for 72h decays upward toward 0.5', () => {
    const now = Date.now();
    const edge = makeEdge({
      id: 'e2',
      from_node: 'a',
      to_node: 'b',
      weight: 0.3,
      created_at: now - 72 * HOUR,
      last_traversed: now - 72 * HOUR,
    });

    const newWeight = scheduler.decayEdge(edge, now);
    expect(newWeight).not.toBeNull();
    expect(newWeight!).toBeGreaterThan(0.3);
    expect(newWeight!).toBeLessThanOrEqual(0.5);
  });

  it('edge at exactly 0.5 returns null (already neutral)', () => {
    const edge = makeEdge({
      id: 'e3',
      from_node: 'a',
      to_node: 'b',
      weight: 0.5,
      last_traversed: Date.now() - 72 * HOUR,
    });

    expect(scheduler.decayEdge(edge, Date.now())).toBeNull();
  });

  it('locked edge returns null', () => {
    const edge = makeEdge({
      id: 'e4',
      from_node: 'a',
      to_node: 'b',
      weight: 0.8,
      locked: true,
      last_traversed: Date.now() - 72 * HOUR,
    });

    expect(scheduler.decayEdge(edge, Date.now())).toBeNull();
  });

  it('within grace period (< 48h) returns null', () => {
    const now = Date.now();
    const edge = makeEdge({
      id: 'e5',
      from_node: 'a',
      to_node: 'b',
      weight: 0.8,
      last_traversed: now - 24 * HOUR, // only 24h ago, grace period is 48h
    });

    expect(scheduler.decayEdge(edge, now)).toBeNull();
  });

  it('never crosses 0.5: edge at 0.48 with large decay clamped at 0.5', () => {
    const now = Date.now();
    const edge = makeEdge({
      id: 'e6',
      from_node: 'a',
      to_node: 'b',
      weight: 0.48,
      decay_rate: 1.0, // extremely high decay rate
      created_at: now - 200 * HOUR,
      last_traversed: now - 200 * HOUR,
    });

    const newWeight = scheduler.decayEdge(edge, now);
    expect(newWeight).not.toBeNull();
    // Should decay toward 0.5 but never exceed it
    expect(newWeight!).toBeLessThanOrEqual(0.5);
    expect(newWeight!).toBeGreaterThanOrEqual(0.48);
  });

  it('max delta is 0.05 per cycle', () => {
    const now = Date.now();
    const edge = makeEdge({
      id: 'e7',
      from_node: 'a',
      to_node: 'b',
      weight: 0.9,
      decay_rate: 1.0, // very high
      created_at: now - 200 * HOUR,
      last_traversed: now - 200 * HOUR,
    });

    const newWeight = scheduler.decayEdge(edge, now);
    expect(newWeight).not.toBeNull();
    // max delta is 0.05, so minimum result is 0.9 - 0.05 = 0.85
    expect(newWeight!).toBeGreaterThanOrEqual(0.85);
  });

  it('full runCycle integration test', async () => {
    const now = Date.now();

    // Create nodes
    const nA = createNode({ id: 'a', graph_id: 'g1', label: 'A', type: NodeType.ENTITY });
    const nB = createNode({ id: 'b', graph_id: 'g1', label: 'B', type: NodeType.ENTITY });
    const nC = createNode({ id: 'c', graph_id: 'g1', label: 'C', type: NodeType.ENTITY });
    graph.addNode(nA);
    graph.addNode(nB);
    graph.addNode(nC);

    // Decayable edge (high weight, old)
    const e1 = createEdge({
      id: 'e1',
      graph_id: 'g1',
      from_node: 'a',
      to_node: 'b',
      type: EdgeType.LEADS_TO,
      weight: 0.8,
    });
    // Override created_at to be old
    (e1 as any).created_at = now - 72 * HOUR;
    graph.addEdge(e1);

    // Locked edge
    const e2 = createEdge({
      id: 'e2',
      graph_id: 'g1',
      from_node: 'b',
      to_node: 'c',
      type: EdgeType.LEADS_TO,
      weight: 0.9,
      locked: true,
    });
    (e2 as any).created_at = now - 72 * HOUR;
    graph.addEdge(e2);

    const report = await scheduler.runCycle(now);

    expect(report.edges_processed).toBe(2);
    expect(report.edges_skipped_locked).toBe(1);
    expect(report.edges_decayed).toBe(1);

    // Verify the decayed edge moved toward 0.5
    const updated = graph.getEdge('e1');
    expect(updated!.weight).toBeLessThan(0.8);

    // Locked edge unchanged
    const locked = graph.getEdge('e2');
    expect(locked!.weight).toBe(0.9);
  });
});
