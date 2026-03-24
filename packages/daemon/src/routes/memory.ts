import { Hono } from 'hono';
import type { GitHubMemorySync } from '../GitHubMemorySync.js';

export function memoryRoutes(deps: { getSync: () => GitHubMemorySync | null }): Hono {
  const app = new Hono();

  // POST /api/memory/push — push to GitHub
  app.post('/push', async (c) => {
    const sync = deps.getSync();
    if (!sync) return c.json({ error: 'GitHub memory not configured. Run: 0agent memory connect github' }, 404);
    const result = await sync.push();
    return c.json(result);
  });

  // POST /api/memory/pull — pull from GitHub
  app.post('/pull', async (c) => {
    const sync = deps.getSync();
    if (!sync) return c.json({ error: 'GitHub memory not configured.' }, 404);
    const result = await sync.pull();
    return c.json(result);
  });

  // GET /api/memory/status — last sync times
  app.get('/status', (c) => {
    const sync = deps.getSync();
    if (!sync) return c.json({ configured: false });
    return c.json({ configured: true, ...sync.getLastSyncTimes() });
  });

  return app;
}
