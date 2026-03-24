/**
 * HTTPServer — Hono-based HTTP server that mounts all route modules.
 */

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { KnowledgeGraph, TraceStore } from '@0agent/core';

// In development: same dir as source. In production bundle: ../dist/graph.html
function findGraphHtml(): string {
  const candidates = [
    resolve(dirname(fileURLToPath(import.meta.url)), 'graph.html'),          // dev (src/)
    resolve(dirname(fileURLToPath(import.meta.url)), '..', 'graph.html'),    // bundled (dist/../)
    resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'graph.html'),
  ];
  for (const p of candidates) {
    try { readFileSync(p); return p; } catch {}
  }
  return candidates[0];
}
const GRAPH_HTML_PATH = findGraphHtml();

import { healthRoutes, type DaemonStatus } from './routes/health.js';
import { sessionRoutes } from './routes/sessions.js';
import { graphRoutes } from './routes/graph.js';
import { entityRoutes } from './routes/entities.js';
import { traceRoutes } from './routes/traces.js';
import { subagentRoutes } from './routes/subagents.js';
import { skillRoutes } from './routes/skills.js';
import { insightsRoutes } from './routes/insights.js';
import { memoryRoutes } from './routes/memory.js';
import { llmRoutes } from './routes/llm.js';
import { codespaceRoutes } from './routes/codespace.js';
import type { CodespaceManager } from './CodespaceManager.js';
import type { SessionManager } from './SessionManager.js';
import type { SkillRegistry } from './SkillRegistry.js';
import type { GitHubMemorySync } from './GitHubMemorySync.js';
import type { ProactiveSurface } from './ProactiveSurface.js';

export interface HTTPServerDeps {
  port: number;
  host: string;
  sessions: SessionManager;
  graph: KnowledgeGraph;
  traceStore: TraceStore;
  skillRegistry: SkillRegistry;
  getStatus: () => DaemonStatus;
  getMemorySync?: () => GitHubMemorySync | null;
  proactiveSurface?: ProactiveSurface | null;
  getCodespaceManager?: () => CodespaceManager | null;
  setupCodespace?: () => Promise<{ started: boolean; error?: string }>;
}

export class HTTPServer {
  private app: Hono;
  private server: Server | null = null;
  private deps: HTTPServerDeps;

  constructor(deps: HTTPServerDeps) {
    this.deps = deps;
    this.app = new Hono();

    // Mount route modules under /api prefix
    this.app.route('/api/health', healthRoutes({ getStatus: deps.getStatus }));
    this.app.route('/api/sessions', sessionRoutes({ sessions: deps.sessions }));
    this.app.route('/api/graph', graphRoutes({ graph: deps.graph }));
    this.app.route('/api/entities', entityRoutes({ graph: deps.graph }));
    this.app.route('/api/traces', traceRoutes({ traceStore: deps.traceStore }));
    this.app.route('/api/subagents', subagentRoutes());
    this.app.route('/api/skills', skillRoutes({ skillRegistry: deps.skillRegistry }));
    this.app.route('/api/insights', insightsRoutes({ proactiveSurface: deps.proactiveSurface ?? null }));
    this.app.route('/api/memory',   memoryRoutes({ getSync: deps.getMemorySync ?? (() => null) }));
    this.app.route('/api/llm',      llmRoutes());
    this.app.route('/api/codespace', codespaceRoutes({
      getManager: deps.getCodespaceManager ?? (() => null),
      setup: deps.setupCodespace ?? (async () => ({ started: false, error: 'Not configured' })),
    }));

    // Serve 3D knowledge graph at root and /graph
    const serveGraph = (c: any) => {
      try {
        const html = readFileSync(GRAPH_HTML_PATH, 'utf8');
        return c.html(html);
      } catch {
        return c.html('<p>Graph UI not found. Run: pnpm build</p>');
      }
    };
    this.app.get('/', serveGraph);
    this.app.get('/graph', serveGraph);
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = serve(
        {
          fetch: this.app.fetch,
          port: this.deps.port,
          hostname: this.deps.host,
        },
        () => {
          resolve();
        },
      ) as unknown as Server;
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  getApp(): Hono {
    return this.app;
  }
}
