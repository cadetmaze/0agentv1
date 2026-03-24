import { Hono } from 'hono';
import type { SchedulerManager } from '../SchedulerManager.js';
import { scheduleToHuman, nextRunAt } from '../SchedulerManager.js';

export function scheduleRoutes(deps: { scheduler: SchedulerManager | null }): Hono {
  const app = new Hono();

  const getScheduler = (c: any) => {
    if (!deps.scheduler) {
      return { error: c.json({ error: 'Scheduler not available' }, 503) };
    }
    return { scheduler: deps.scheduler };
  };

  // GET /api/schedule — list all jobs
  app.get('/', (c) => {
    const { scheduler, error } = getScheduler(c);
    if (error) return error;
    const jobs = scheduler!.list().map(j => ({
      ...j,
      schedule_human: j.schedule_human || scheduleToHuman(j.schedule),
      next_run_human: new Date(j.next_run_at).toLocaleString(),
    }));
    return c.json(jobs);
  });

  // POST /api/schedule — add a job
  // Body: { task: string, schedule: string, name?: string, skill?: string }
  app.post('/', async (c) => {
    const { scheduler, error } = getScheduler(c);
    if (error) return error;

    const body = await c.req.json() as { task?: string; schedule?: string; name?: string; skill?: string };
    if (!body.task || !body.schedule) {
      return c.json({ error: 'task and schedule are required' }, 400);
    }

    try {
      const job = scheduler!.add({
        task: body.task,
        schedule: body.schedule,
        name: body.name,
        skill: body.skill,
      });
      return c.json({
        ...job,
        next_run_human: new Date(job.next_run_at).toLocaleString(),
      }, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // DELETE /api/schedule/:id — remove a job
  app.delete('/:id', (c) => {
    const { scheduler, error } = getScheduler(c);
    if (error) return error;
    const ok = scheduler!.remove(c.req.param('id'));
    return ok ? c.json({ ok: true }) : c.json({ error: 'Job not found' }, 404);
  });

  // POST /api/schedule/:id/pause
  app.post('/:id/pause', (c) => {
    const { scheduler, error } = getScheduler(c);
    if (error) return error;
    const ok = scheduler!.setPaused(c.req.param('id'), true);
    return ok ? c.json({ ok: true }) : c.json({ error: 'Job not found' }, 404);
  });

  // POST /api/schedule/:id/resume
  app.post('/:id/resume', (c) => {
    const { scheduler, error } = getScheduler(c);
    if (error) return error;
    const ok = scheduler!.setPaused(c.req.param('id'), false);
    return ok ? c.json({ ok: true }) : c.json({ error: 'Job not found' }, 404);
  });

  return app;
}
