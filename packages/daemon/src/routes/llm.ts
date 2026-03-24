import { Hono } from 'hono';
import { LLMExecutor } from '../LLMExecutor.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import YAML from 'yaml';

export function llmRoutes(): Hono {
  const app = new Hono();

  /**
   * POST /api/llm/ping
   * Tests LLM connectivity from the daemon process.
   * Returns { ok, model, latency_ms, error? }
   */
  app.post('/ping', async (c) => {
    const start = Date.now();
    try {
      const configPath = resolve(homedir(), '.0agent', 'config.yaml');
      if (!existsSync(configPath)) {
        return c.json({ ok: false, error: 'Config not found. Run: 0agent init' });
      }

      const cfg = YAML.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
      const providers = cfg.llm_providers as Array<Record<string, unknown>> | undefined;
      const def = providers?.find(p => p.is_default) ?? providers?.[0];

      if (!def) {
        return c.json({ ok: false, error: 'No LLM provider in config' });
      }

      const apiKey = String(def.api_key ?? '').trim();
      if (!apiKey && def.provider !== 'ollama') {
        return c.json({ ok: false, error: `No API key for ${def.provider}. Run: 0agent init` });
      }

      const executor = new LLMExecutor({
        provider: String(def.provider),
        model:    String(def.model),
        api_key:  apiKey,
        base_url: def.base_url ? String(def.base_url) : undefined,
      });

      // Minimal 1-token completion
      const result = await executor.complete(
        [{ role: 'user', content: 'Reply with the word: ready' }],
        'You are a helpful assistant. Reply with exactly one word.',
      );

      return c.json({
        ok: true,
        model: String(def.model),
        provider: String(def.provider),
        latency_ms: Date.now() - start,
        response: result.content.trim().slice(0, 20),
      });
    } catch (err) {
      return c.json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        latency_ms: Date.now() - start,
      });
    }
  });

  return app;
}
