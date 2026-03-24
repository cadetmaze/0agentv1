import { Hono } from 'hono';
import type { KnowledgeGraph } from '@0agent/core';

export function entityRoutes(deps: { graph: KnowledgeGraph }): Hono {
  const app = new Hono();

  // GET /api/entities — list entity nodes (type='entity')
  app.get('/', (c) => {
    const results = deps.graph.queryStructural({
      node_type: 'entity' as any,
      limit: 200,
    });
    return c.json(results.map((r) => r.node));
  });

  // GET /api/entities/:id — get entity + subgraph summary
  app.get('/:id', (c) => {
    const id = c.req.param('id');
    const node = deps.graph.getNode(id);
    if (!node) {
      return c.json({ error: 'Entity not found' }, 404);
    }

    // Build subgraph summary
    try {
      const subgraph = deps.graph.getSubGraph(id, 2);
      const nodes = subgraph.getNodes();
      const edges = subgraph.getEdges();

      // Find latest last_seen across all nodes in subgraph
      let last_seen = node.last_seen;
      for (const n of nodes) {
        if (n.last_seen > last_seen) {
          last_seen = n.last_seen;
        }
      }

      return c.json({
        ...node,
        subgraph_summary: {
          nodeCount: nodes.length,
          edgeCount: edges.length,
          last_seen,
        },
      });
    } catch {
      // If subgraph fails (e.g., node exists but isn't entity root), return node alone
      return c.json({
        ...node,
        subgraph_summary: {
          nodeCount: 1,
          edgeCount: 0,
          last_seen: node.last_seen,
        },
      });
    }
  });

  return app;
}
