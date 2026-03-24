import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SQLiteAdapter } from '../../../packages/core/src/storage/adapters/SQLiteAdapter';
import { KnowledgeGraph } from '../../../packages/core/src/graph/KnowledgeGraph';
import { HypothesisManager } from '../../../packages/core/src/bootstrap/HypothesisManager';
import { createNode, NodeType } from '../../../packages/core/src/graph/GraphNode';

describe('HypothesisManager', () => {
  let adapter: SQLiteAdapter;
  let graph: KnowledgeGraph;
  let manager: HypothesisManager;

  beforeEach(() => {
    adapter = new SQLiteAdapter({ db_path: ':memory:' });
    graph = new KnowledgeGraph(adapter);
    manager = new HypothesisManager(graph);
  });

  afterEach(() => {
    adapter.close();
  });

  function addHypothesisNode(id: string): void {
    const node = createNode({
      id,
      graph_id: 'g1',
      label: `Hypothesis ${id}`,
      type: NodeType.HYPOTHESIS,
    });
    graph.addNode(node);
  }

  it('should register a hypothesis', () => {
    addHypothesisNode('h1');
    const record = manager.register('h1');

    expect(record.node_id).toBe('h1');
    expect(record.promoted).toBe(false);
    expect(record.demoted).toBe(false);
    expect(record.outcome_count).toBe(0);
    expect(record.positive_outcomes).toBe(0);
    expect(record.negative_outcomes).toBe(0);

    expect(manager.isHypothesis('h1')).toBe(true);
  });

  it('auto-promotes after 3+ positive outcomes (rate >= 0.7)', () => {
    addHypothesisNode('h-promote');
    manager.register('h-promote');

    // 3 positive outcomes out of 3 = rate 1.0 >= 0.7
    manager.recordOutcome('h-promote', true);
    manager.recordOutcome('h-promote', true);
    manager.recordOutcome('h-promote', true);

    const record = manager.get('h-promote');
    expect(record!.promoted).toBe(true);
    expect(record!.outcome_count).toBe(3);
    expect(record!.positive_outcomes).toBe(3);

    // No longer considered an active hypothesis
    expect(manager.isHypothesis('h-promote')).toBe(false);
  });

  it('auto-demotes after 3+ negative outcomes (rate <= 0.3)', () => {
    addHypothesisNode('h-demote');
    manager.register('h-demote');

    // 3 negative outcomes out of 3 = rate 0.0 <= 0.3
    manager.recordOutcome('h-demote', false);
    manager.recordOutcome('h-demote', false);
    manager.recordOutcome('h-demote', false);

    const record = manager.get('h-demote');
    expect(record!.demoted).toBe(true);
    expect(record!.outcome_count).toBe(3);
    expect(record!.negative_outcomes).toBe(3);
  });

  it('demote removes node from graph', () => {
    addHypothesisNode('h-remove');
    manager.register('h-remove');

    expect(graph.getNode('h-remove')).not.toBeNull();

    manager.demote('h-remove');

    expect(graph.getNode('h-remove')).toBeNull();
    expect(manager.get('h-remove')!.demoted).toBe(true);
  });

  it('pruneExpired removes old hypotheses', () => {
    addHypothesisNode('h-expired');
    const record = manager.register('h-expired');

    // Move expires_at into the past
    (record as any).expires_at = Date.now() - 1000;

    const pruned = manager.pruneExpired();
    expect(pruned).toBe(1);

    expect(manager.get('h-expired')!.demoted).toBe(true);
    // Node should be removed from graph
    expect(graph.getNode('h-expired')).toBeNull();
  });
});
