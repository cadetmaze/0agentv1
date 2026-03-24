import { Hono } from 'hono';
import type { KnowledgeGraph } from '@0agent/core';

export function graphRoutes(deps: { graph: KnowledgeGraph }): Hono {
  const app = new Hono();

  // GET /api/graph/nodes?graph_id=&type=&limit=
  app.get('/nodes', (c) => {
    const graph_id = c.req.query('graph_id');
    const type = c.req.query('type');
    const limitStr = c.req.query('limit');
    const limit = limitStr ? parseInt(limitStr, 10) : 50;

    const results = deps.graph.queryStructural({
      graph_id: graph_id || undefined,
      node_type: type as any || undefined,
      limit,
    });

    return c.json(results.map((r) => r.node));
  });

  // GET /api/graph/nodes/:id
  app.get('/nodes/:id', (c) => {
    const id = c.req.param('id');
    const node = deps.graph.getNode(id);
    if (!node) {
      return c.json({ error: 'Node not found' }, 404);
    }
    return c.json(node);
  });

  // GET /api/graph/edges?from_node=&to_node=&type=
  app.get('/edges', (c) => {
    const from_node = c.req.query('from_node');
    const to_node = c.req.query('to_node');
    const type = c.req.query('type');

    let edges;
    if (from_node && to_node) {
      edges = deps.graph.getEdgesBetween(from_node, to_node);
    } else if (from_node) {
      edges = deps.graph.getEdgesFrom(from_node);
    } else if (to_node) {
      edges = deps.graph.getEdgesTo(to_node);
    } else {
      edges = deps.graph.getAllEdges();
    }

    if (type) {
      edges = edges.filter((e) => e.type === type);
    }

    return c.json(edges);
  });

  // POST /api/graph/query — body: { structural?, semantic?, limit? }
  app.post('/query', async (c) => {
    const body = await c.req.json<{
      structural?: Record<string, unknown>;
      semantic?: Record<string, unknown>;
      limit?: number;
    }>();

    const results = deps.graph.queryMerged({
      structural: (body.structural ?? {}) as any,
      semantic: body.semantic as any,
      limit: body.limit,
    });

    return c.json(results);
  });

  return app;
}
