import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SQLiteAdapter } from '../../../packages/core/src/storage/adapters/SQLiteAdapter';
import { KnowledgeGraph } from '../../../packages/core/src/graph/KnowledgeGraph';
import { createNode, NodeType, ContentType } from '../../../packages/core/src/graph/GraphNode';
import { createEdge, EdgeType } from '../../../packages/core/src/graph/GraphEdge';

describe('KnowledgeGraph', () => {
  let adapter: SQLiteAdapter;
  let graph: KnowledgeGraph;

  beforeEach(() => {
    adapter = new SQLiteAdapter({ db_path: ':memory:' });
    graph = new KnowledgeGraph(adapter);
  });

  afterEach(() => {
    adapter.close();
  });

  // ── Node CRUD ──────────────────────────────

  it('should create a node and read it back with all fields', () => {
    const node = createNode({
      id: 'node-1',
      graph_id: 'g1',
      label: 'Test Node',
      type: NodeType.ENTITY,
      metadata: { foo: 'bar' },
      content: [
        {
          id: 'c1',
          node_id: 'node-1',
          type: ContentType.TEXT,
          data: 'hello world',
          metadata: { lang: 'en' },
        },
      ],
    });

    graph.addNode(node);
    const fetched = graph.getNode('node-1');

    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe('node-1');
    expect(fetched!.graph_id).toBe('g1');
    expect(fetched!.label).toBe('Test Node');
    expect(fetched!.type).toBe(NodeType.ENTITY);
    expect(fetched!.visit_count).toBe(1);
    expect(fetched!.metadata).toEqual({ foo: 'bar' });
    expect(fetched!.subgraph_id).toBeNull();
    expect(fetched!.embedding).toBeNull();
    expect(fetched!.content).toHaveLength(1);
    expect(fetched!.content[0].id).toBe('c1');
    expect(fetched!.content[0].data).toBe('hello world');
    expect(fetched!.content[0].metadata).toEqual({ lang: 'en' });
  });

  it('should update last_seen and increment visit_count', () => {
    const node = createNode({
      id: 'node-2',
      graph_id: 'g1',
      label: 'Visit Node',
      type: NodeType.ENTITY,
    });
    graph.addNode(node);

    const before = graph.getNode('node-2')!;
    expect(before.visit_count).toBe(1);

    graph.touchNode('node-2');

    const after = graph.getNode('node-2')!;
    expect(after.visit_count).toBe(2);
    expect(after.last_seen).toBeGreaterThanOrEqual(before.last_seen);
  });

  it('should delete a node and cascade-delete its content', () => {
    const node = createNode({
      id: 'node-del',
      graph_id: 'g1',
      label: 'To Delete',
      type: NodeType.ENTITY,
      content: [
        {
          id: 'c-del',
          node_id: 'node-del',
          type: ContentType.TEXT,
          data: 'gone',
          metadata: {},
        },
      ],
    });
    graph.addNode(node);
    expect(graph.getNode('node-del')).not.toBeNull();

    graph.deleteNode('node-del');

    expect(graph.getNode('node-del')).toBeNull();
    // Content should also be gone (CASCADE)
    const content = adapter.getNodeContent('node-del');
    expect(content).toHaveLength(0);
  });

  // ── Edge CRUD ──────────────────────────────

  it('should create an edge and read it back with all fields', () => {
    const nodeA = createNode({ id: 'a', graph_id: 'g1', label: 'A', type: NodeType.ENTITY });
    const nodeB = createNode({ id: 'b', graph_id: 'g1', label: 'B', type: NodeType.ENTITY });
    graph.addNode(nodeA);
    graph.addNode(nodeB);

    const edge = createEdge({
      id: 'e1',
      graph_id: 'g1',
      from_node: 'a',
      to_node: 'b',
      type: EdgeType.LEADS_TO,
      weight: 0.8,
      metadata: { reason: 'test' },
    });
    graph.addEdge(edge);

    const fetched = graph.getEdge('e1');
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe('e1');
    expect(fetched!.from_node).toBe('a');
    expect(fetched!.to_node).toBe('b');
    expect(fetched!.type).toBe(EdgeType.LEADS_TO);
    expect(fetched!.weight).toBe(0.8);
    expect(fetched!.locked).toBe(false);
    expect(fetched!.decay_rate).toBe(0.001);
    expect(fetched!.traversal_count).toBe(0);
    expect(fetched!.last_traversed).toBeNull();
    expect(fetched!.metadata).toEqual({ reason: 'test' });
  });

  it('should get edges by direction: from, to, both', () => {
    const nodeA = createNode({ id: 'a', graph_id: 'g1', label: 'A', type: NodeType.ENTITY });
    const nodeB = createNode({ id: 'b', graph_id: 'g1', label: 'B', type: NodeType.ENTITY });
    const nodeC = createNode({ id: 'c', graph_id: 'g1', label: 'C', type: NodeType.ENTITY });
    graph.addNode(nodeA);
    graph.addNode(nodeB);
    graph.addNode(nodeC);

    graph.addEdge(createEdge({ id: 'e1', graph_id: 'g1', from_node: 'a', to_node: 'b', type: EdgeType.LEADS_TO }));
    graph.addEdge(createEdge({ id: 'e2', graph_id: 'g1', from_node: 'c', to_node: 'a', type: EdgeType.SUPPORTS }));

    const fromA = graph.getEdgesFrom('a');
    expect(fromA).toHaveLength(1);
    expect(fromA[0].id).toBe('e1');

    const toA = graph.getEdgesTo('a');
    expect(toA).toHaveLength(1);
    expect(toA[0].id).toBe('e2');

    const bothA = graph.getEdgesByNode('a', 'both');
    expect(bothA).toHaveLength(2);
  });

  // ── Subgraph BFS ───────────────────────────

  it('should BFS getSubGraph(A, depth=2) returning A,B,C but not D', () => {
    // Chain: A → B → C → D
    const nodeA = createNode({ id: 'A', graph_id: 'g1', label: 'A', type: NodeType.ENTITY });
    const nodeB = createNode({ id: 'B', graph_id: 'g1', label: 'B', type: NodeType.ENTITY });
    const nodeC = createNode({ id: 'C', graph_id: 'g1', label: 'C', type: NodeType.ENTITY });
    const nodeD = createNode({ id: 'D', graph_id: 'g1', label: 'D', type: NodeType.ENTITY });
    graph.addNode(nodeA);
    graph.addNode(nodeB);
    graph.addNode(nodeC);
    graph.addNode(nodeD);

    graph.addEdge(createEdge({ id: 'ab', graph_id: 'g1', from_node: 'A', to_node: 'B', type: EdgeType.LEADS_TO }));
    graph.addEdge(createEdge({ id: 'bc', graph_id: 'g1', from_node: 'B', to_node: 'C', type: EdgeType.LEADS_TO }));
    graph.addEdge(createEdge({ id: 'cd', graph_id: 'g1', from_node: 'C', to_node: 'D', type: EdgeType.LEADS_TO }));

    const sub = graph.getSubGraph('A', 2);
    const nodeIds = sub.getNodes().map((n) => n.id).sort();

    expect(nodeIds).toContain('A');
    expect(nodeIds).toContain('B');
    expect(nodeIds).toContain('C');
    expect(nodeIds).not.toContain('D');
  });

  // ── Structural query ───────────────────────

  it('should return structural query results ordered by weight desc', () => {
    const root = createNode({ id: 'root', graph_id: 'g1', label: 'Root', type: NodeType.ENTITY });
    const t1 = createNode({ id: 't1', graph_id: 'g1', label: 'T1', type: NodeType.STRATEGY });
    const t2 = createNode({ id: 't2', graph_id: 'g1', label: 'T2', type: NodeType.STRATEGY });
    const t3 = createNode({ id: 't3', graph_id: 'g1', label: 'T3', type: NodeType.STRATEGY });
    graph.addNode(root);
    graph.addNode(t1);
    graph.addNode(t2);
    graph.addNode(t3);

    graph.addEdge(createEdge({ id: 'e1', graph_id: 'g1', from_node: 'root', to_node: 't1', type: EdgeType.LEADS_TO, weight: 0.3 }));
    graph.addEdge(createEdge({ id: 'e2', graph_id: 'g1', from_node: 'root', to_node: 't2', type: EdgeType.LEADS_TO, weight: 0.9 }));
    graph.addEdge(createEdge({ id: 'e3', graph_id: 'g1', from_node: 'root', to_node: 't3', type: EdgeType.LEADS_TO, weight: 0.6 }));

    const results = graph.queryStructural({
      from_node: 'root',
      order_by: 'weight_desc',
    });

    expect(results).toHaveLength(3);
    expect(results[0].score).toBe(0.9);
    expect(results[1].score).toBe(0.6);
    expect(results[2].score).toBe(0.3);
  });

  // ── Counts ─────────────────────────────────

  it('should report correct nodeCount and edgeCount', () => {
    expect(graph.nodeCount()).toBe(0);
    expect(graph.edgeCount()).toBe(0);

    const n1 = createNode({ id: 'n1', graph_id: 'g1', label: 'N1', type: NodeType.ENTITY });
    const n2 = createNode({ id: 'n2', graph_id: 'g1', label: 'N2', type: NodeType.ENTITY });
    graph.addNode(n1);
    graph.addNode(n2);

    expect(graph.nodeCount()).toBe(2);

    graph.addEdge(createEdge({ id: 'e1', graph_id: 'g1', from_node: 'n1', to_node: 'n2', type: EdgeType.LEADS_TO }));
    expect(graph.edgeCount()).toBe(1);
  });

  // ── getEdgesBetween ────────────────────────

  it('should get edges between specific nodes', () => {
    const n1 = createNode({ id: 'n1', graph_id: 'g1', label: 'N1', type: NodeType.ENTITY });
    const n2 = createNode({ id: 'n2', graph_id: 'g1', label: 'N2', type: NodeType.ENTITY });
    const n3 = createNode({ id: 'n3', graph_id: 'g1', label: 'N3', type: NodeType.ENTITY });
    graph.addNode(n1);
    graph.addNode(n2);
    graph.addNode(n3);

    graph.addEdge(createEdge({ id: 'e1', graph_id: 'g1', from_node: 'n1', to_node: 'n2', type: EdgeType.LEADS_TO }));
    graph.addEdge(createEdge({ id: 'e2', graph_id: 'g1', from_node: 'n1', to_node: 'n3', type: EdgeType.SUPPORTS }));
    graph.addEdge(createEdge({ id: 'e3', graph_id: 'g1', from_node: 'n1', to_node: 'n2', type: EdgeType.SUPPORTS }));

    const between = graph.getEdgesBetween('n1', 'n2');
    expect(between).toHaveLength(2);
    const ids = between.map((e) => e.id).sort();
    expect(ids).toEqual(['e1', 'e3']);
  });
});
