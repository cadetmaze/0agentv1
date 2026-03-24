import { Hono } from 'hono';
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import type { SkillDefinition } from '@0agent/core';
import type { SkillRegistry } from '../SkillRegistry.js';

export function skillRoutes(deps: { skillRegistry: SkillRegistry }): Hono {
  const app = new Hono();

  // GET /api/skills — list all skills
  app.get('/', (c) => {
    const skills = deps.skillRegistry.list();
    return c.json(skills);
  });

  // GET /api/skills/:name — get single skill by name
  app.get('/:name', (c) => {
    const name = c.req.param('name');
    const skill = deps.skillRegistry.get(name);
    if (!skill) {
      return c.json({ error: 'Skill not found' }, 404);
    }
    return c.json(skill);
  });

  // POST /api/skills — create custom skill
  app.post('/', async (c) => {
    const body = await c.req.json<{ name: string; yaml: string }>();

    if (!body.name || typeof body.name !== 'string') {
      return c.json({ error: 'name is required' }, 400);
    }
    if (!body.yaml || typeof body.yaml !== 'string') {
      return c.json({ error: 'yaml is required' }, 400);
    }

    // Check for conflicts with built-in skills
    if (deps.skillRegistry.isBuiltin(body.name)) {
      return c.json({ error: 'Conflicts with built-in skill' }, 409);
    }

    try {
      const skill = deps.skillRegistry.createCustom(body.name, body.yaml);
      return c.json(skill, 201);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  // DELETE /api/skills/:name — remove custom skill
  app.delete('/:name', (c) => {
    const name = c.req.param('name');

    // Cannot delete built-in skills
    if (deps.skillRegistry.isBuiltin(name)) {
      return c.json({ error: 'Cannot delete built-in skill' }, 403);
    }

    const skill = deps.skillRegistry.get(name);
    if (!skill) {
      return c.json({ error: 'Skill not found' }, 404);
    }

    try {
      deps.skillRegistry.removeCustom(name);
      return c.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  return app;
}
