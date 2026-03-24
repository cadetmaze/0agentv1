import { Hono } from 'hono';
import type { CodespaceManager } from '../CodespaceManager.js';

export function codespaceRoutes(deps: {
  getManager: () => CodespaceManager | null;
  setup: () => Promise<{ started: boolean; error?: string }>;
}): Hono {
  const app = new Hono();

  // GET /api/codespace/status
  app.get('/status', async (c) => {
    const mgr = deps.getManager();
    if (!mgr) return c.json({ configured: false, state: 'not_configured' });

    const info = mgr.findExisting();
    const ping = mgr.isReady() ? await mgr.ping().catch(() => null) : null;

    return c.json({
      configured: true,
      state: info?.state ?? 'not_found',
      name: info?.name ?? null,
      ready: mgr.isReady(),
      browser_ok: ping?.ok ?? false,
    });
  });

  // POST /api/codespace/setup — provision + start + open tunnel
  app.post('/setup', async (c) => {
    const result = await deps.setup();
    return c.json(result);
  });

  // POST /api/codespace/start — wake up a stopped codespace
  app.post('/start', async (c) => {
    const mgr = deps.getManager();
    if (!mgr) return c.json({ ok: false, error: 'Not configured' }, 404);
    try {
      const url = await mgr.getReadyUrl();
      return c.json({ ok: true, url });
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/codespace/stop — stop to save free-tier hours
  app.post('/stop', async (c) => {
    const mgr = deps.getManager();
    if (!mgr) return c.json({ ok: false, error: 'Not configured' }, 404);
    try {
      await mgr.stop();
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  return app;
}
