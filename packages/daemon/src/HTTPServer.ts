/**
 * HTTPServer — Hono-based HTTP server that mounts all route modules.
 */

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import type { KnowledgeGraph, TraceStore } from '@0agent/core';

import { healthRoutes, type DaemonStatus } from './routes/health.js';
import { sessionRoutes } from './routes/sessions.js';
import { graphRoutes } from './routes/graph.js';
import { entityRoutes } from './routes/entities.js';
import { traceRoutes } from './routes/traces.js';
import { subagentRoutes } from './routes/subagents.js';
import { skillRoutes } from './routes/skills.js';
import type { SessionManager } from './SessionManager.js';
import type { SkillRegistry } from './SkillRegistry.js';

export interface HTTPServerDeps {
  port: number;
  host: string;
  sessions: SessionManager;
  graph: KnowledgeGraph;
  traceStore: TraceStore;
  skillRegistry: SkillRegistry;
  getStatus: () => DaemonStatus;
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

    // Root endpoint
    this.app.get('/', (c) => {
      return c.json({ name: '0agent-daemon', version: '2.0.0' });
    });
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
