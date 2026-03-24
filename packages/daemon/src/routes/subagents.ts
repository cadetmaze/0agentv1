import { Hono } from 'hono';

export function subagentRoutes(): Hono {
  const app = new Hono();

  // GET /api/subagents — returns empty array (no subagents in Phase 2)
  app.get('/', (c) => {
    return c.json([]);
  });

  // DELETE /api/subagents/:id — returns 404 "no subagent system in Phase 2"
  app.delete('/:id', (c) => {
    return c.json({ error: 'No subagent system in Phase 2' }, 404);
  });

  return app;
}
