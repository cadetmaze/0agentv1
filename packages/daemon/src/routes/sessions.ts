import { Hono } from 'hono';
import type { SessionManager, CreateSessionRequest } from '../SessionManager.js';

export function sessionRoutes(deps: { sessions: SessionManager }): Hono {
  const app = new Hono();

  // POST /api/sessions — create and run a session
  app.post('/', async (c) => {
    const body = await c.req.json<CreateSessionRequest>();

    if (!body.task || typeof body.task !== 'string') {
      return c.json({ error: 'task is required and must be a string' }, 400);
    }

    const session = deps.sessions.createSession(body);

    // Run asynchronously in the background — don't await
    deps.sessions.runSession(body).catch(() => {
      // Errors are handled inside runSession (failSession)
    });

    return c.json({ session_id: session.id, status: 'pending' }, 201);
  });

  // GET /api/sessions — list all sessions
  app.get('/', (c) => {
    const sessions = deps.sessions.listSessions();
    return c.json(sessions);
  });

  // GET /api/sessions/:id — get session by id
  app.get('/:id', (c) => {
    const id = c.req.param('id');
    const session = deps.sessions.getSession(id);
    if (!session) {
      return c.json({ error: 'Session not found' }, 404);
    }
    return c.json(session);
  });

  // DELETE /api/sessions/:id — cancel a session
  app.delete('/:id', (c) => {
    const id = c.req.param('id');
    const session = deps.sessions.getSession(id);
    if (!session) {
      return c.json({ error: 'Session not found' }, 404);
    }
    deps.sessions.cancelSession(id);
    return c.json({ ok: true });
  });

  return app;
}
