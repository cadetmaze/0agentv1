import { Hono } from 'hono';
import type { TraceStore } from '@0agent/core';

export function traceRoutes(deps: { traceStore: TraceStore }): Hono {
  const app = new Hono();

  // GET /api/traces?session_id=&deferred=&limit=
  app.get('/', (c) => {
    const session_id = c.req.query('session_id');
    const deferredStr = c.req.query('deferred');
    const limitStr = c.req.query('limit');

    const deferred = deferredStr !== undefined && deferredStr !== ''
      ? deferredStr === 'true'
      : undefined;
    const limit = limitStr ? parseInt(limitStr, 10) : undefined;

    const traces = deps.traceStore.query({
      session_id: session_id || undefined,
      deferred,
      limit,
    });

    return c.json(traces);
  });

  // GET /api/traces/:id
  app.get('/:id', (c) => {
    const id = c.req.param('id');
    const trace = deps.traceStore.get(id);
    if (!trace) {
      return c.json({ error: 'Trace not found' }, 404);
    }
    return c.json(trace);
  });

  return app;
}
