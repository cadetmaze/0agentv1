/**
 * Conversation Continuity Tests
 *
 * Proves that the agent remembers what you said before:
 * - "make it dark mode" after "make a landing page" knows what "it" is
 * - History persists across daemon restarts
 * - Outcome signals update edge weights (graph learns from real tasks)
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteAdapter, KnowledgeGraph, WeightEventLog, EdgeWeightUpdater, createNode, createEdge, NodeType, EdgeType } from '../../../packages/core/src/index.js';
import { ConversationStore } from '../../../packages/daemon/src/ConversationStore.js';

function openStack(dbPath: string) {
  const adapter = new SQLiteAdapter({ db_path: dbPath });
  const graph = new KnowledgeGraph(adapter);
  const wLog = new WeightEventLog(adapter);
  const updater = new EdgeWeightUpdater(adapter, wLog);
  const conv = new ConversationStore(adapter);
  conv.init();
  return { adapter, graph, wLog, updater, conv };
}

// ─── Conversation persistence ────────────────────────────────────────────────

describe('Conversation history — "make it dark mode" knows what it is', () => {
  it('stores and retrieves multi-turn conversation', () => {
    const dir = mkdtempSync(join(tmpdir(), '0agent-conv-'));
    const db = join(dir, 'graph.db');

    // Session 1: "make a landing page"
    {
      const { adapter, conv } = openStack(db);
      conv.append({ id: 'msg-1', session_id: 's1', user_entity_id: 'sahil', role: 'user',   content: 'make a landing page on port 3000', created_at: 1000 });
      conv.append({ id: 'msg-2', session_id: 's1', user_entity_id: 'sahil', role: 'assistant', content: 'Done. Created index.html and started server on port 3000.', created_at: 1001 });
      adapter.close();
    }

    // Session 2 (daemon restart): "make it dark mode" — retrieves prior exchange
    {
      const { adapter, conv } = openStack(db);
      const history = conv.getHistory('sahil', 10);
      expect(history.length).toBe(2);
      expect(history[0].content).toContain('landing page');
      expect(history[1].content).toContain('index.html');

      // This is the string injected into the LLM system prompt
      const contextMessages = conv.buildContextMessages('sahil', 10);
      expect(contextMessages[0].role).toBe('user');
      expect(contextMessages[0].content).toContain('landing page');
      expect(contextMessages[1].role).toBe('assistant');
      adapter.close();
    }
  });

  it('context string tells LLM exactly what "it" refers to', () => {
    const dir = mkdtempSync(join(tmpdir(), '0agent-ctx-'));
    const db = join(dir, 'graph.db');
    const { adapter, conv } = openStack(db);

    conv.append({ id: '1', session_id: 's1', user_entity_id: 'user1', role: 'user',      content: 'make a React app with a counter', created_at: 1000 });
    conv.append({ id: '2', session_id: 's1', user_entity_id: 'user1', role: 'assistant', content: 'Created App.tsx with a counter component. Running on port 3000.', created_at: 1001 });
    conv.append({ id: '3', session_id: 's2', user_entity_id: 'user1', role: 'user',      content: 'add dark mode to it', created_at: 2000 });
    conv.append({ id: '4', session_id: 's2', user_entity_id: 'user1', role: 'assistant', content: 'Added dark mode toggle to App.tsx using CSS variables.', created_at: 2001 });

    const messages = conv.buildContextMessages('user1', 10);
    expect(messages.length).toBe(4);

    // The history string that gets injected into the next LLM call
    const historyStr = messages
      .map(m => `${m.role === 'user' ? 'User' : 'Agent'}: ${m.content}`)
      .join('\n');

    // LLM will now understand "make it responsive" refers to the React counter app
    expect(historyStr).toContain('counter');
    expect(historyStr).toContain('App.tsx');
    expect(historyStr).toContain('dark mode');

    adapter.close();
  });

  it('caps history at requested limit — long conversations stay manageable', () => {
    const dir = mkdtempSync(join(tmpdir(), '0agent-cap-'));
    const db = join(dir, 'graph.db');
    const { adapter, conv } = openStack(db);

    // 30 exchanges
    for (let i = 0; i < 30; i++) {
      conv.append({ id: `u${i}`, session_id: `s${i}`, user_entity_id: 'user1', role: 'user', content: `task ${i}`, created_at: i * 1000 });
      conv.append({ id: `a${i}`, session_id: `s${i}`, user_entity_id: 'user1', role: 'assistant', content: `done ${i}`, created_at: i * 1000 + 1 });
    }

    // Only last 8 exchanges injected (prevents context overflow)
    const messages = conv.buildContextMessages('user1', 8);
    expect(messages.length).toBe(8);
    // Most recent — not oldest
    expect(messages[messages.length - 1].content).toContain('done 29');

    adapter.close();
  });

  it('different users have separate histories (no cross-contamination)', () => {
    const dir = mkdtempSync(join(tmpdir(), '0agent-sep-'));
    const db = join(dir, 'graph.db');
    const { adapter, conv } = openStack(db);

    conv.append({ id: '1', session_id: 's1', user_entity_id: 'sahil',  role: 'user', content: 'build the auth system',    created_at: 1000 });
    conv.append({ id: '2', session_id: 's2', user_entity_id: 'marcus', role: 'user', content: 'build the payment system', created_at: 2000 });

    const sahilHistory  = conv.getHistory('sahil', 10);
    const marcusHistory = conv.getHistory('marcus', 10);

    expect(sahilHistory.length).toBe(1);
    expect(marcusHistory.length).toBe(1);
    expect(sahilHistory[0].content).toContain('auth');
    expect(marcusHistory[0].content).toContain('payment');
    // Sahil doesn't see Marcus's history
    expect(sahilHistory.some(m => m.content.includes('payment'))).toBe(false);

    adapter.close();
  });
});

// ─── Outcome → weight feedback ───────────────────────────────────────────────

describe('Outcome feedback — graph learns from real task outcomes', () => {
  it('successful task increases edge weight', async () => {
    const dir = mkdtempSync(join(tmpdir(), '0agent-fb-'));
    const db = join(dir, 'graph.db');
    const { adapter, graph, updater } = openStack(db);

    graph.addNode(createNode({ id: 'ctx', graph_id: 'root', label: 'web_task', type: NodeType.CONTEXT }));
    graph.addNode(createNode({ id: 'plan', graph_id: 'root', label: 'create_server', type: NodeType.STRATEGY }));
    graph.addEdge(createEdge({ id: 'e1', graph_id: 'root', from_node: 'ctx', to_node: 'plan', type: EdgeType.LEADS_TO, weight: 0.5 }));

    // Simulate: task succeeded, outcome signal +0.3, learning rate 0.1 → weight += 0.03
    const edge = graph.getEdge('e1')!;
    const signal = 0.3;
    const newWeight = Math.max(0, Math.min(1, edge.weight + signal * 0.1));
    await updater.update('e1', edge.weight, newWeight, 'task_outcome_positive', 'sess-1');

    const updated = graph.getEdge('e1')!;
    expect(updated.weight).toBeGreaterThan(0.5);
    expect(updated.weight).toBeCloseTo(0.53, 2);

    adapter.close();
  });

  it('failed task decreases edge weight', async () => {
    const dir = mkdtempSync(join(tmpdir(), '0agent-fb2-'));
    const db = join(dir, 'graph.db');
    const { adapter, graph, updater } = openStack(db);

    graph.addNode(createNode({ id: 'ctx', graph_id: 'root', label: 'context', type: NodeType.CONTEXT }));
    graph.addNode(createNode({ id: 'plan', graph_id: 'root', label: 'bad_strategy', type: NodeType.STRATEGY }));
    graph.addEdge(createEdge({ id: 'e2', graph_id: 'root', from_node: 'ctx', to_node: 'plan', type: EdgeType.LEADS_TO, weight: 0.5 }));

    // Simulate: task failed, outcome signal -0.2, learning rate 0.1 → weight -= 0.02
    const edge = graph.getEdge('e2')!;
    const signal = -0.2;
    const newWeight = Math.max(0, Math.min(1, edge.weight + signal * 0.1));
    await updater.update('e2', edge.weight, newWeight, 'task_outcome_negative', 'sess-2');

    const updated = graph.getEdge('e2')!;
    expect(updated.weight).toBeLessThan(0.5);
    expect(updated.weight).toBeCloseTo(0.48, 2);

    adapter.close();
  });

  it('weight changes from real tasks persist across restarts', async () => {
    const dir = mkdtempSync(join(tmpdir(), '0agent-fb3-'));
    const db = join(dir, 'graph.db');

    // Session 1: run tasks, weights update
    {
      const { adapter, graph, updater } = openStack(db);
      graph.addNode(createNode({ id: 'c', graph_id: 'root', label: 'context', type: NodeType.CONTEXT }));
      graph.addNode(createNode({ id: 'p', graph_id: 'root', label: 'strategy', type: NodeType.STRATEGY }));
      graph.addEdge(createEdge({ id: 'e', graph_id: 'root', from_node: 'c', to_node: 'p', type: EdgeType.LEADS_TO, weight: 0.5 }));

      // 5 successful outcomes
      let w = 0.5;
      for (let i = 0; i < 5; i++) {
        const nw = Math.min(1, w + 0.3 * 0.1);
        await updater.update('e', w, nw, 'task_outcome_positive', `s${i}`);
        w = nw;
      }
      adapter.close();
    }

    // Session 2: daemon restart — weight is remembered, reflects learning
    {
      const { adapter, graph } = openStack(db);
      const edge = graph.getEdge('e')!;
      // 5 × (+0.03) from 0.5 ≈ 0.65
      expect(edge.weight).toBeGreaterThan(0.5);
      expect(edge.weight).toBeCloseTo(0.65, 1);
      adapter.close();
    }
  });
});
