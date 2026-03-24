import { Hono } from 'hono';
import type { ProactiveSurface } from '../ProactiveSurface.js';

// ProactiveSurface injected as dep — lazy, may be null if Collab-2 not wired
export function insightsRoutes(deps: { proactiveSurface?: ProactiveSurface | null }): Hono {
  const app = new Hono();

  // GET /api/insights?seen=false
  app.get('/', (c) => {
    if (!deps.proactiveSurface) return c.json([]);
    const seen = c.req.query('seen');
    const insights = seen === 'false'
      ? deps.proactiveSurface.getUnseen()
      : deps.proactiveSurface.getAll();
    return c.json(insights);
  });

  // POST /api/insights/:id/seen
  app.post('/:id/seen', (c) => {
    if (!deps.proactiveSurface) return c.json({ ok: false, error: 'not available' }, 404);
    deps.proactiveSurface.markSeen(c.req.param('id'));
    return c.json({ ok: true });
  });

  return app;
}
