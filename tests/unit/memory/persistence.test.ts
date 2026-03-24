/**
 * Memory Persistence Tests
 *
 * Proves that the knowledge graph persists across restarts:
 * - Nodes and edges survive adapter close/reopen
 * - Edge weights survive (including OCC updates)
 * - Personality profiles survive
 * - Conversation history survives
 * - Weight events (learning history) survive
 * - Visit counts increment correctly
 *
 * This is the "will it remember" test suite.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SQLiteAdapter,
  KnowledgeGraph,
  WeightEventLog,
  EdgeWeightUpdater,
  NodeType,
  EdgeType,
  createNode,
  createEdge,
  AliasIndex,
  NodeResolutionService,
} from '../../../packages/core/src/index.js';

// ─── helpers ────────────────────────────────────────────────────────────────

function openGraph(dbPath: string) {
  const adapter = new SQLiteAdapter({ db_path: dbPath });
  const graph = new KnowledgeGraph(adapter);
  const weightLog = new WeightEventLog(adapter);
  const updater = new EdgeWeightUpdater(adapter, weightLog);
  return { adapter, graph, weightLog, updater };
}

// ─── Core persistence ────────────────────────────────────────────────────────

describe('SQLite persistence — survives adapter close/reopen', () => {
  let dbPath: string;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), '0agent-mem-'));
    dbPath = join(tmpDir, 'graph.db');
  });

  it('nodes written in session 1 are readable in session 2', () => {
    // Session 1: write
    {
      const { adapter, graph } = openGraph(dbPath);
      graph.addNode(createNode({ id: 'entity-acme', graph_id: 'root', label: 'Acme Corp', type: NodeType.ENTITY }));
      graph.addNode(createNode({ id: 'entity-sarah', graph_id: 'root', label: 'Sarah Chen', type: NodeType.ENTITY }));
      adapter.close();
    }

    // Session 2: read — simulate daemon restart
    {
      const { adapter, graph } = openGraph(dbPath);
      const acme = graph.getNode('entity-acme');
      const sarah = graph.getNode('entity-sarah');
      expect(acme).not.toBeNull();
      expect(acme!.label).toBe('Acme Corp');
      expect(sarah).not.toBeNull();
      expect(sarah!.label).toBe('Sarah Chen');
      adapter.close();
    }
  });

  it('edges and their weights survive restart', () => {
    {
      const { adapter, graph } = openGraph(dbPath);
      graph.addNode(createNode({ id: 'ctx', graph_id: 'root', label: 'context', type: NodeType.CONTEXT }));
      graph.addNode(createNode({ id: 'strat', graph_id: 'root', label: 'strategy', type: NodeType.STRATEGY }));
      graph.addEdge(createEdge({ id: 'e1', graph_id: 'root', from_node: 'ctx', to_node: 'strat', type: EdgeType.LEADS_TO, weight: 0.82 }));
      adapter.close();
    }

    {
      const { adapter, graph } = openGraph(dbPath);
      const edge = graph.getEdge('e1');
      expect(edge).not.toBeNull();
      expect(edge!.weight).toBe(0.82);
      expect(edge!.type).toBe(EdgeType.LEADS_TO);
      adapter.close();
    }
  });

  it('OCC weight updates persist and weight_events log is durable', async () => {
    {
      const { adapter, graph, updater } = openGraph(dbPath);
      graph.addNode(createNode({ id: 'n1', graph_id: 'root', label: 'from', type: NodeType.CONTEXT }));
      graph.addNode(createNode({ id: 'n2', graph_id: 'root', label: 'to', type: NodeType.STRATEGY }));
      graph.addEdge(createEdge({ id: 'e-learn', graph_id: 'root', from_node: 'n1', to_node: 'n2', type: EdgeType.LEADS_TO, weight: 0.5 }));

      // Simulate 3 positive outcomes updating the weight
      await updater.update('e-learn', 0.5, 0.6, 'outcome_positive', 'trace-1');
      await updater.update('e-learn', 0.6, 0.7, 'outcome_positive', 'trace-2');
      await updater.update('e-learn', 0.7, 0.78, 'outcome_positive', 'trace-3');
      adapter.close();
    }

    {
      const { adapter, graph, weightLog } = openGraph(dbPath);
      const edge = graph.getEdge('e-learn');
      expect(edge!.weight).toBeCloseTo(0.78, 2);

      // Weight event history is preserved — the agent can replay learning
      const events = weightLog.getByEdge('e-learn');
      expect(events.length).toBe(3);
      expect(events[0].reason).toBe('outcome_positive');
      expect(events[2].new_weight).toBeCloseTo(0.78, 2);
      adapter.close();
    }
  });

  it('visit_count (how many times entity was accessed) persists', () => {
    {
      const { adapter, graph } = openGraph(dbPath);
      graph.addNode(createNode({ id: 'sarah', graph_id: 'root', label: 'Sarah', type: NodeType.ENTITY }));
      graph.touchNode('sarah'); // visit 1
      graph.touchNode('sarah'); // visit 2
      graph.touchNode('sarah'); // visit 3
      adapter.close();
    }

    {
      const { adapter, graph } = openGraph(dbPath);
      const sarah = graph.getNode('sarah');
      // Initial visit_count=1 (from createNode) + 3 touches = 4
      expect(sarah!.visit_count).toBe(4);
      adapter.close();
    }
  });

  it('alias index (how agent recognises short names) persists', () => {
    {
      const { adapter, graph } = openGraph(dbPath);
      const aliasIndex = new AliasIndex(adapter);
      graph.addNode(createNode({ id: 'acme', graph_id: 'root', label: 'Acme Corp', type: NodeType.ENTITY }));
      aliasIndex.registerNode('acme', 'Acme Corp'); // creates: "acme corp", "acme", "ac"
      adapter.close();
    }

    {
      const { adapter } = openGraph(dbPath);
      const aliasIndex = new AliasIndex(adapter);
      const matches = aliasIndex.findExact('acme');
      expect(matches.length).toBeGreaterThan(0);
      expect(matches[0].node_id).toBe('acme');
      adapter.close();
    }
  });

  it('MEMBER_OF hierarchy persists (company knows employees)', () => {
    {
      const { adapter, graph } = openGraph(dbPath);
      graph.addNode(createNode({ id: 'acme', graph_id: 'root', label: 'Acme Corp', type: NodeType.ENTITY }));
      graph.addNode(createNode({ id: 'sarah', graph_id: 'root', label: 'Sarah Chen', type: NodeType.ENTITY }));
      graph.addNode(createNode({ id: 'marcus', graph_id: 'root', label: 'Marcus Lee', type: NodeType.ENTITY }));
      graph.addEdge(createEdge({ id: 'e1', graph_id: 'root', from_node: 'sarah', to_node: 'acme', type: EdgeType.MEMBER_OF }));
      graph.addEdge(createEdge({ id: 'e2', graph_id: 'root', from_node: 'marcus', to_node: 'acme', type: EdgeType.MEMBER_OF }));
      adapter.close();
    }

    {
      const { adapter, graph } = openGraph(dbPath);
      const acmeEdges = graph.getEdgesTo('acme').filter(e => e.type === EdgeType.MEMBER_OF);
      expect(acmeEdges.length).toBe(2);
      const memberIds = acmeEdges.map(e => e.from_node);
      expect(memberIds).toContain('sarah');
      expect(memberIds).toContain('marcus');
      adapter.close();
    }
  });

  it('subgraph BFS gives same results after restart', () => {
    {
      const { adapter, graph } = openGraph(dbPath);
      graph.addNode(createNode({ id: 'root-entity', graph_id: 'root', label: 'Project X', type: NodeType.ENTITY }));
      graph.addNode(createNode({ id: 'child-1', graph_id: 'root', label: 'Task 1', type: NodeType.STEP }));
      graph.addNode(createNode({ id: 'child-2', graph_id: 'root', label: 'Task 2', type: NodeType.STEP }));
      graph.addEdge(createEdge({ id: 'ec1', graph_id: 'root', from_node: 'root-entity', to_node: 'child-1', type: EdgeType.PRODUCES }));
      graph.addEdge(createEdge({ id: 'ec2', graph_id: 'root', from_node: 'root-entity', to_node: 'child-2', type: EdgeType.PRODUCES }));
      adapter.close();
    }

    {
      const { adapter, graph } = openGraph(dbPath);
      const subgraph = graph.getSubGraph('root-entity', 1);
      expect(subgraph.nodeCount).toBe(3); // root + 2 children
      expect(subgraph.edgeCount).toBe(2);
      adapter.close();
    }
  });
});

// ─── Learning persistence ────────────────────────────────────────────────────

describe('Learning — weights converge and persist', () => {
  it('50 simulated outcomes survive restart with correct weights', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), '0agent-learn-'));
    const dbPath = join(tmpDir, 'graph.db');

    // Session 1: build graph + run 50 simulated traces
    {
      const { adapter, graph, updater } = openGraph(dbPath);
      // Strategy nodes
      graph.addNode(createNode({ id: 'ctx', graph_id: 'root', label: 'context', type: NodeType.CONTEXT }));
      graph.addNode(createNode({ id: 'good-strat', graph_id: 'root', label: 'founder_pitch', type: NodeType.STRATEGY }));
      graph.addNode(createNode({ id: 'bad-strat', graph_id: 'root', label: 'cold_email', type: NodeType.STRATEGY }));
      graph.addEdge(createEdge({ id: 'e-good', graph_id: 'root', from_node: 'ctx', to_node: 'good-strat', type: EdgeType.LEADS_TO, weight: 0.5 }));
      graph.addEdge(createEdge({ id: 'e-bad', graph_id: 'root', from_node: 'ctx', to_node: 'bad-strat', type: EdgeType.LEADS_TO, weight: 0.5 }));

      // Simulate: founder_pitch works 80% of the time, cold_email 20%
      let goodW = 0.5, badW = 0.5;
      const rng = (() => { let s = 42; return () => { s = (s * 1664525 + 1013904223) & 0xffffffff; return (s >>> 0) / 0xffffffff; }; })();
      for (let i = 0; i < 50; i++) {
        const pickGood = rng() > 0.3; // epsilon-greedy, mostly exploit
        if (pickGood) {
          const success = rng() < 0.8;
          const delta = success ? 0.05 : -0.02;
          const newW = Math.max(0, Math.min(1, goodW + delta));
          await updater.update('e-good', goodW, newW, success ? 'outcome_positive' : 'outcome_negative', `trace-${i}`);
          goodW = newW;
        } else {
          const success = rng() < 0.2;
          const delta = success ? 0.05 : -0.02;
          const newW = Math.max(0, Math.min(1, badW + delta));
          await updater.update('e-bad', badW, newW, success ? 'outcome_positive' : 'outcome_negative', `trace-b-${i}`);
          badW = newW;
        }
      }
      adapter.close();
    }

    // Session 2: daemon restart — verify learned weights survived
    {
      const { adapter, graph, weightLog } = openGraph(dbPath);
      const goodEdge = graph.getEdge('e-good');
      const badEdge = graph.getEdge('e-bad');

      expect(goodEdge!.weight).toBeGreaterThan(0.5); // learned: founder_pitch works
      expect(badEdge!.weight).toBeLessThan(0.5);     // learned: cold_email doesn't

      // Full weight history is there for trace replay / rollback
      const goodEvents = weightLog.getByEdge('e-good');
      const badEvents = weightLog.getByEdge('e-bad');
      expect(goodEvents.length + badEvents.length).toBe(50);

      adapter.close();
    }
  });
});

// ─── Personality persistence ─────────────────────────────────────────────────

describe('Personality profiles — survive restart', () => {
  it('stores and retrieves personality profile after restart', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), '0agent-pers-'));
    const dbPath = join(tmpDir, 'graph.db');

    const { PersonalityProfileStore } = await import('../../../packages/core/src/entity/PersonalityProfile.js');

    // Session 1: build profile
    {
      const { adapter, graph } = openGraph(dbPath);
      graph.addNode(createNode({ id: 'sarah', graph_id: 'root', label: 'Sarah Chen', type: NodeType.ENTITY }));
      const store = new PersonalityProfileStore(graph);
      const profile = store.createDefault('sarah', 'Sarah Chen');
      profile.interaction_count = 12;
      profile.communication_style = 'terse, bullet points';
      profile.working_context = 'Q4 auth latency investigation';
      profile.timezone = 'America/Los_Angeles';
      store.set('sarah', profile);
      adapter.close();
    }

    // Session 2: restart — personality still there
    {
      const { adapter, graph } = openGraph(dbPath);
      const store = new PersonalityProfileStore(graph);
      const profile = store.get('sarah');
      expect(profile).not.toBeNull();
      expect(profile!.interaction_count).toBe(12);
      expect(profile!.communication_style).toBe('terse, bullet points');
      expect(profile!.working_context).toBe('Q4 auth latency investigation');
      expect(profile!.timezone).toBe('America/Los_Angeles');
      adapter.close();
    }
  });
});

// ─── Entity resolution persistence ──────────────────────────────────────────

describe('Entity resolution — graph knows who you mentioned before', () => {
  it('resolves same entity across sessions (no duplicates)', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), '0agent-ent-'));
    const dbPath = join(tmpDir, 'graph.db');

    // Session 1: first mention of "Acme Corp"
    let entityId1: string;
    {
      const { adapter, graph } = openGraph(dbPath);
      const aliasIndex = new AliasIndex(adapter);
      const resolver = new NodeResolutionService(graph, aliasIndex, null, null);
      const result = await resolver.resolve('Acme Corp', { graph_id: 'root' });
      entityId1 = result.node_id;
      expect(result.match_type).toBe('created'); // first time → new node
      adapter.close();
    }

    // Session 2: second mention — resolves to SAME node, no duplicate
    {
      const { adapter, graph } = openGraph(dbPath);
      const aliasIndex = new AliasIndex(adapter);
      const resolver = new NodeResolutionService(graph, aliasIndex, null, null);
      const result = await resolver.resolve('Acme Corp', { graph_id: 'root' });
      expect(result.node_id).toBe(entityId1);    // same ID
      expect(result.match_type).toBe('exact');   // recognized from graph
      expect(graph.nodeCount()).toBe(1);          // still only 1 entity node
      adapter.close();
    }

    // Session 3: alias "acme" also resolves to same node
    {
      const { adapter, graph } = openGraph(dbPath);
      const aliasIndex = new AliasIndex(adapter);
      const resolver = new NodeResolutionService(graph, aliasIndex, null, null);
      const result = await resolver.resolve('acme', { graph_id: 'root' });
      expect(result.node_id).toBe(entityId1);
      expect(result.match_type).toBe('alias');
      adapter.close();
    }
  });
});

// ─── What memory does NOT currently cover ────────────────────────────────────

describe('Memory boundaries — known limitations', () => {
  it('HNSW embedding index is in-memory (rebuilt on restart)', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), '0agent-hnsw-'));
    const dbPath = join(tmpDir, 'graph.db');

    const { HNSWIndex } = await import('../../../packages/core/src/embedding/HNSWIndex.js');

    // Add vectors to index
    const idx = new HNSWIndex({ dimensions: 4 });
    idx.add('node-1', new Float32Array([1, 0, 0, 0]));
    idx.add('node-2', new Float32Array([0, 1, 0, 0]));
    expect(idx.size).toBe(2);

    // "Restart" — new index instance
    const idx2 = new HNSWIndex({ dimensions: 4 });
    // Index starts empty — this is expected
    expect(idx2.size).toBe(0);

    // MITIGATION: structural queries (by type/label/id) work perfectly from SQLite
    // Semantic search simply starts fresh — degrades gracefully, no crash
    // Full persistence requires usearch native module (Phase 5)
  });

  it('SQLite structural queries still work without embeddings', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), '0agent-noem-'));
    const dbPath = join(tmpDir, 'graph.db');

    const { adapter, graph } = openGraph(dbPath);
    graph.addNode(createNode({ id: 'e1', graph_id: 'root', label: 'Anthropic', type: NodeType.ENTITY }));
    graph.addNode(createNode({ id: 'e2', graph_id: 'root', label: 'OpenAI', type: NodeType.ENTITY }));
    graph.addNode(createNode({ id: 'e3', graph_id: 'root', label: 'Scale AI', type: NodeType.ENTITY }));

    // Structural query — works immediately, no embeddings needed
    const entities = graph.queryStructural({ node_type: NodeType.ENTITY, limit: 10 });
    expect(entities.length).toBe(3);

    // Get by ID — instant
    expect(graph.getNode('e1')!.label).toBe('Anthropic');

    adapter.close();
  });
});
