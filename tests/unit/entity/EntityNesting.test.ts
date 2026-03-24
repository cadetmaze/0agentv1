/**
 * Entity Nesting Tests
 *
 * Verifies:
 * - Company → Employee MEMBER_OF relationships
 * - PersonalityProfile creation and retrieval
 * - PersonalityAccumulator updates profile from interactions
 * - EntityHierarchy loads personal + parent context
 * - Cross-entity signal propagation (attenuated)
 * - Privacy: personality profile NOT propagated to parent
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  KnowledgeGraph,
  SQLiteAdapter,
  NodeType,
  EdgeType,
  createNode,
  createEdge,
} from '../../../packages/core/src/index.js';
import { PersonalityProfileStore } from '../../../packages/core/src/entity/PersonalityProfile.js';
import { EntityHierarchy, DEFAULT_VISIBILITY_POLICY } from '../../../packages/core/src/entity/EntityHierarchy.js';
import { PersonalityAccumulator } from '../../../packages/core/src/entity/PersonalityAccumulator.js';

function buildTestGraph() {
  const adapter = new SQLiteAdapter({ db_path: ':memory:' });
  const graph = new KnowledgeGraph(adapter);
  return { adapter, graph };
}

describe('Entity Nesting — MEMBER_OF hierarchy', () => {
  let graph: KnowledgeGraph;

  beforeEach(() => {
    ({ graph } = buildTestGraph());

    // Acme Corp (company)
    graph.addNode(createNode({ id: 'acme', graph_id: 'root', label: 'Acme Corp', type: NodeType.ENTITY }));
    // Sarah (employee)
    graph.addNode(createNode({ id: 'sarah', graph_id: 'root', label: 'Sarah Chen', type: NodeType.ENTITY }));
    // Marcus (employee)
    graph.addNode(createNode({ id: 'marcus', graph_id: 'root', label: 'Marcus Lee', type: NodeType.ENTITY }));

    // Sarah -MEMBER_OF-> Acme Corp
    graph.addEdge(createEdge({ id: 'e1', graph_id: 'root', from_node: 'sarah', to_node: 'acme', type: EdgeType.MEMBER_OF }));
    // Marcus -MEMBER_OF-> Acme Corp
    graph.addEdge(createEdge({ id: 'e2', graph_id: 'root', from_node: 'marcus', to_node: 'acme', type: EdgeType.MEMBER_OF }));
  });

  it('getParents returns Acme Corp for Sarah', () => {
    const hierarchy = new EntityHierarchy(graph);
    const parents = hierarchy.getParents('sarah');
    expect(parents).toHaveLength(1);
    expect(parents[0].label).toBe('Acme Corp');
  });

  it('getMembers returns Sarah and Marcus for Acme Corp', () => {
    const hierarchy = new EntityHierarchy(graph);
    const members = hierarchy.getMembers('acme');
    expect(members).toHaveLength(2);
    const labels = members.map(m => m.label);
    expect(labels).toContain('Sarah Chen');
    expect(labels).toContain('Marcus Lee');
  });

  it('loadEntityContext includes personal nodes and parent shared nodes', () => {
    // Add a strategy node in Acme's subgraph — connected via edge so BFS finds it
    graph.addNode(createNode({
      id: 'acme-q4-strategy',
      graph_id: 'root',
      label: 'Q4 Auth Migration',
      type: NodeType.STRATEGY,
      subgraph_id: 'acme',
    }));
    // Connect acme → strategy node so BFS at depth 1 finds it
    graph.addEdge(createEdge({
      id: 'e-acme-q4',
      graph_id: 'root',
      from_node: 'acme',
      to_node: 'acme-q4-strategy',
      type: EdgeType.LEADS_TO,
    }));

    const hierarchy = new EntityHierarchy(graph);
    const ctx = hierarchy.loadEntityContext('sarah');

    expect(ctx.entity.label).toBe('Sarah Chen');
    expect(ctx.parent_entities).toHaveLength(1);
    expect(ctx.parent_entities[0].label).toBe('Acme Corp');

    // Shared node from Acme (strategy type) should be visible
    const sharedLabels = ctx.shared_subgraph_ids.map(id => graph.getNode(id)?.label);
    // Strategy nodes are shared per DEFAULT_VISIBILITY_POLICY
    expect(sharedLabels).toContain('Q4 Auth Migration');
  });
});

describe('PersonalityProfile — creation and update', () => {
  let graph: KnowledgeGraph;
  let profileStore: PersonalityProfileStore;

  beforeEach(() => {
    ({ graph } = buildTestGraph());
    graph.addNode(createNode({ id: 'sarah', graph_id: 'root', label: 'Sarah Chen', type: NodeType.ENTITY }));
    profileStore = new PersonalityProfileStore(graph);
  });

  it('returns null for entity with no profile', () => {
    expect(profileStore.get('sarah')).toBeNull();
  });

  it('creates and retrieves a default profile', () => {
    const profile = profileStore.createDefault('sarah', 'Sarah Chen');
    profileStore.set('sarah', profile);

    const retrieved = profileStore.get('sarah');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.entity_id).toBe('sarah');
    expect(retrieved!.interaction_count).toBe(0);
  });

  it('updates profile with new interaction count', () => {
    const profile = profileStore.createDefault('sarah', 'Sarah Chen');
    profile.interaction_count = 5;
    profile.communication_style = 'direct, bullet-points';
    profileStore.set('sarah', profile);

    const retrieved = profileStore.get('sarah');
    expect(retrieved!.interaction_count).toBe(5);
    expect(retrieved!.communication_style).toBe('direct, bullet-points');
  });
});

describe('PersonalityAccumulator — signal synthesis', () => {
  let graph: KnowledgeGraph;
  let profileStore: PersonalityProfileStore;
  let hierarchy: EntityHierarchy;
  let accumulator: PersonalityAccumulator;

  beforeEach(() => {
    ({ graph } = buildTestGraph());
    graph.addNode(createNode({ id: 'acme', graph_id: 'root', label: 'Acme Corp', type: NodeType.ENTITY }));
    graph.addNode(createNode({ id: 'sarah', graph_id: 'root', label: 'Sarah Chen', type: NodeType.ENTITY }));
    graph.addEdge(createEdge({ id: 'e1', graph_id: 'root', from_node: 'sarah', to_node: 'acme', type: EdgeType.MEMBER_OF }));

    profileStore = new PersonalityProfileStore(graph);
    hierarchy = new EntityHierarchy(graph);
    accumulator = new PersonalityAccumulator(graph, profileStore, hierarchy);
  });

  it('accumulates interaction and increments count', async () => {
    await accumulator.accumulate({
      entity_id: 'sarah',
      session_id: 'sess-1',
      input: 'pull auth metrics',
      output: 'Here are the auth metrics: ...',
      skill_name: 'research',
      outcome_signal: 0.8,
      duration_ms: 1200,
      timestamp: Date.now(),
    });

    const profile = profileStore.get('sarah');
    expect(profile).not.toBeNull();
    expect(profile!.interaction_count).toBe(1);
    expect(profile!.raw_signals).toHaveLength(1);
  });

  it('detects terse communication style after repeated short inputs', async () => {
    const now = Date.now();
    // 6 terse interactions
    for (let i = 0; i < 6; i++) {
      await accumulator.accumulate({
        entity_id: 'sarah',
        session_id: `sess-${i}`,
        input: 'show metrics',   // < 8 words = terse
        output: 'Here: ...',
        duration_ms: 500,
        timestamp: now + i * 1000,
      });
    }

    const profile = profileStore.get('sarah');
    expect(profile!.communication_style).toContain('terse');
  });

  it('propagates signal to parent entity (Acme Corp)', async () => {
    await accumulator.accumulate({
      entity_id: 'sarah',
      session_id: 'sess-1',
      input: 'run the deployment',
      output: 'Deployed.',
      skill_name: 'build',
      outcome_signal: 1.0,
      duration_ms: 5000,
      timestamp: Date.now(),
    });

    // Acme Corp's subgraph should have a signal node from Sarah
    const acmeSubgraph = graph.getSubGraph('acme', 1);
    const signalNodes = acmeSubgraph.getNodes().filter(
      n => n.type === NodeType.SIGNAL && n.metadata?.source_entity === 'sarah'
    );
    expect(signalNodes.length).toBeGreaterThan(0);
    expect(signalNodes[0].label).toContain('/build');
  });
});

describe('VisibilityPolicy — privacy boundaries', () => {
  it('personality profile is NOT propagated to company by default', async () => {
    const { graph } = buildTestGraph();
    graph.addNode(createNode({ id: 'acme', graph_id: 'root', label: 'Acme Corp', type: NodeType.ENTITY }));
    graph.addNode(createNode({ id: 'sarah', graph_id: 'root', label: 'Sarah Chen', type: NodeType.ENTITY }));
    graph.addEdge(createEdge({ id: 'e1', graph_id: 'root', from_node: 'sarah', to_node: 'acme', type: EdgeType.MEMBER_OF }));

    const profileStore = new PersonalityProfileStore(graph);
    const profile = profileStore.createDefault('sarah', 'Sarah Chen');
    profile.communication_style = 'direct, no small talk';
    profileStore.set('sarah', profile);

    // DEFAULT policy: allow_personality_profile = false
    const hierarchy = new EntityHierarchy(graph, DEFAULT_VISIBILITY_POLICY);
    const ctx = hierarchy.loadEntityContext('sarah');

    // Shared nodes should NOT include the personality profile node
    const sharedNodes = ctx.shared_subgraph_ids
      .map(id => graph.getNode(id))
      .filter(Boolean);
    const profileInShared = sharedNodes.find(n => n?.label === '__personality_profile__');
    expect(profileInShared).toBeUndefined();
  });
});

describe('buildContextPrompt — system prompt injection', () => {
  it('returns empty string for entity with < 3 interactions', async () => {
    const { graph } = buildTestGraph();
    graph.addNode(createNode({ id: 'sarah', graph_id: 'root', label: 'Sarah', type: NodeType.ENTITY }));
    const profileStore = new PersonalityProfileStore(graph);
    const hierarchy = new EntityHierarchy(graph);
    const accumulator = new PersonalityAccumulator(graph, profileStore, hierarchy);

    await accumulator.accumulate({
      entity_id: 'sarah', session_id: 's1', input: 'hi', output: 'hello',
      duration_ms: 100, timestamp: Date.now(),
    });

    const prompt = accumulator.buildContextPrompt('sarah');
    // Only 1 interaction, should be empty (threshold is 3)
    expect(prompt).toBe('');
  });

  it('returns personality context after enough interactions', async () => {
    const { graph } = buildTestGraph();
    graph.addNode(createNode({ id: 'sarah', graph_id: 'root', label: 'Sarah', type: NodeType.ENTITY }));
    const profileStore = new PersonalityProfileStore(graph);
    const hierarchy = new EntityHierarchy(graph);
    const accumulator = new PersonalityAccumulator(graph, profileStore, hierarchy);

    // Manually set a rich profile
    const profile = profileStore.createDefault('sarah', 'Sarah');
    profile.interaction_count = 10;
    profile.communication_style = 'direct, bullet-points';
    profile.working_context = 'auth latency investigation';
    profile.timezone = 'America/Los_Angeles';
    profileStore.set('sarah', profile);

    const prompt = accumulator.buildContextPrompt('sarah');
    expect(prompt).toContain('direct, bullet-points');
    expect(prompt).toContain('auth latency investigation');
    expect(prompt).toContain('America/Los_Angeles');
  });
});
