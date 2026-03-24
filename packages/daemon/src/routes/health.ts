import { Hono } from 'hono';

export interface DaemonStatus {
  version: string;
  uptime_ms: number;
  graph_nodes: number;
  graph_edges: number;
  active_sessions: number;
  mcp_servers_connected: number;
  workers_running: string[];
  sandbox_backend: string;
}

export function healthRoutes(deps: { getStatus: () => DaemonStatus }): Hono {
  const app = new Hono();

  // GET /api/health
  app.get('/', (c) => {
    const status = deps.getStatus();
    return c.json({ ok: true, timestamp: Date.now(), ...status });
  });

  return app;
}
