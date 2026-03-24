import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SQLiteAdapter } from '../../../packages/core/src/storage/adapters/SQLiteAdapter';
import { KnowledgeGraph } from '../../../packages/core/src/graph/KnowledgeGraph';
import { AliasIndex } from '../../../packages/core/src/entity/AliasIndex';
import { NodeResolutionService } from '../../../packages/core/src/entity/NodeResolutionService';
import { createNode, NodeType } from '../../../packages/core/src/graph/GraphNode';

describe('NodeResolutionService', () => {
  let adapter: SQLiteAdapter;
  let graph: KnowledgeGraph;
  let aliasIndex: AliasIndex;
  let resolver: NodeResolutionService;

  beforeEach(() => {
    adapter = new SQLiteAdapter({ db_path: ':memory:' });
    graph = new KnowledgeGraph(adapter);
    aliasIndex = new AliasIndex(adapter);
    // Pass null for embedder and hnswIndex since we don't have real embedding models
    resolver = new NodeResolutionService(graph, aliasIndex, null, null);
  });

  afterEach(() => {
    adapter.close();
  });

  it('exact label match returns "exact" with confidence 1.0', async () => {
    const node = createNode({
      id: 'existing-1',
      graph_id: 'root',
      label: 'Acme Corp',
      type: NodeType.ENTITY,
    });
    graph.addNode(node);

    const result = await resolver.resolve('Acme Corp', { graph_id: 'root', type: NodeType.ENTITY });

    expect(result.node_id).toBe('existing-1');
    expect(result.confidence).toBe(1.0);
    expect(result.match_type).toBe('exact');
  });

  it('alias match returns "alias" with alias confidence', async () => {
    const node = createNode({
      id: 'alias-node',
      graph_id: 'root',
      label: 'Acme Corporation',
      type: NodeType.ENTITY,
    });
    graph.addNode(node);

    // Register an alias
    aliasIndex.add('acme', 'alias-node', 0.9);

    const result = await resolver.resolve('acme', { graph_id: 'root', type: NodeType.ENTITY });

    expect(result.node_id).toBe('alias-node');
    expect(result.confidence).toBe(0.9);
    expect(result.match_type).toBe('alias');
  });

  it('no match creates new node and returns "created"', async () => {
    const result = await resolver.resolve('Brand New Entity', { graph_id: 'root', type: NodeType.ENTITY });

    expect(result.match_type).toBe('created');
    expect(result.confidence).toBe(1.0);

    // The new node should exist in the graph
    const newNode = graph.getNode(result.node_id);
    expect(newNode).not.toBeNull();
    expect(newNode!.label).toBe('Brand New Entity');
    expect(newNode!.type).toBe(NodeType.ENTITY);
  });

  it('dedup: resolving same label twice returns same node_id', async () => {
    // First resolution creates the node
    const result1 = await resolver.resolve('Unique Entity', { graph_id: 'root', type: NodeType.ENTITY });
    expect(result1.match_type).toBe('created');

    // Second resolution should find the existing node (via alias registered during creation)
    const result2 = await resolver.resolve('Unique Entity', { graph_id: 'root', type: NodeType.ENTITY });

    // Should resolve to the same node (either via exact match or alias)
    expect(result2.node_id).toBe(result1.node_id);
    expect(result2.match_type).not.toBe('created');
  });
});
