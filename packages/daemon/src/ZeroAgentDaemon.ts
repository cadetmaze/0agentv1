/**
 * ZeroAgentDaemon — Main orchestrator that wires all subsystems together.
 *
 * Startup order:
 *   1. Load config
 *   2. Open SQLiteAdapter + KnowledgeGraph
 *   3. Initialize InferenceEngine
 *   4. Initialize SkillRegistry
 *   5. Create SessionManager
 *   6. Create BackgroundWorkers, start them
 *   7. Create WebSocketEventBus
 *   8. Create HTTPServer, start it
 *   9. Write PID file
 *  10. Log startup
 *  11. Register signal handlers
 */

import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

import {
  SQLiteAdapter,
  KnowledgeGraph,
  TraceStore,
  InferenceEngine,
  NodeResolutionService,
  SelectionPolicy,
  AliasIndex,
} from '@0agent/core';

import { loadConfig } from './config/DaemonConfig.js';
import type { DaemonConfig } from './config/ConfigSchema.js';
import { SessionManager } from './SessionManager.js';
import { WebSocketEventBus } from './WebSocketEvents.js';
import { BackgroundWorkers } from './BackgroundWorkers.js';
import { SkillRegistry } from './SkillRegistry.js';
import { HTTPServer } from './HTTPServer.js';
import { LLMExecutor } from './LLMExecutor.js';
import { IdentityManager } from './IdentityManager.js';
import { ProjectScanner } from './ProjectScanner.js';
import { TeamManager } from './TeamManager.js';
import { TeamSync } from './TeamSync.js';
import type { DaemonStatus } from './routes/health.js';

// ─── Types ───────────────────────────────────────────

export interface DaemonStartupOptions {
  config_path?: string;
}

// ─── ZeroAgentDaemon ─────────────────────────────────

export class ZeroAgentDaemon {
  private config: DaemonConfig | null = null;
  private adapter: SQLiteAdapter | null = null;
  private graph: KnowledgeGraph | null = null;
  private traceStore: TraceStore | null = null;
  private inferenceEngine: InferenceEngine | null = null;
  private sessionManager: SessionManager | null = null;
  private eventBus: WebSocketEventBus | null = null;
  private httpServer: HTTPServer | null = null;
  private skillRegistry: SkillRegistry | null = null;
  private backgroundWorkers: BackgroundWorkers | null = null;
  private startedAt: number = 0;
  private pidFilePath: string;

  constructor() {
    this.pidFilePath = resolve(homedir(), '.0agent', 'daemon.pid');
  }

  async start(opts?: DaemonStartupOptions): Promise<void> {
    // 1. Load config
    this.config = await loadConfig(opts?.config_path);

    // Ensure .0agent directory exists
    const dotDir = resolve(homedir(), '.0agent');
    if (!existsSync(dotDir)) {
      mkdirSync(dotDir, { recursive: true });
    }

    // 2. Open SQLiteAdapter + KnowledgeGraph
    this.adapter = new SQLiteAdapter({ db_path: this.config.graph.db_path });
    this.graph = new KnowledgeGraph(this.adapter);
    this.traceStore = new TraceStore(this.adapter);

    // 3. Initialize InferenceEngine
    const aliasIndex = new AliasIndex(this.adapter);
    const resolver = new NodeResolutionService(this.graph, aliasIndex, null, null);
    const policy = new SelectionPolicy();
    this.inferenceEngine = new InferenceEngine(this.graph, resolver, policy);

    // 4. Initialize SkillRegistry
    this.skillRegistry = new SkillRegistry();
    await this.skillRegistry.loadAll();

    // 5. Create LLM executor from config
    const defaultLLM = this.config.llm_providers.find(p => p.is_default) ?? this.config.llm_providers[0];
    const llmExecutor = defaultLLM
      ? new LLMExecutor({
          provider: defaultLLM.provider,
          model: defaultLLM.model,
          api_key: defaultLLM.api_key ?? '',
          base_url: defaultLLM.base_url,
        })
      : undefined;

    if (llmExecutor?.isConfigured) {
      console.log(`[0agent] LLM: ${defaultLLM?.provider}/${defaultLLM?.model}`);
    } else {
      console.warn('[0agent] No LLM API key configured — tasks will not call the LLM');
    }

    // 5.5 — Collab-1: initialize user identity + project context
    const cwd = process.env['ZEROAGENT_CWD'] ?? process.cwd();
    const identityManager = new IdentityManager(this.graph);
    const identity = await identityManager.init().catch(() => null);
    if (identity) {
      console.log(`[0agent] Identity: ${identity.name} (${identity.device_id})`);
    }

    const projectScanner = new ProjectScanner(cwd);
    // Run project scan in background — non-blocking, cached for session lifetime
    const projectContext = await projectScanner.scan().catch(() => null);
    if (projectContext?.stack?.length) {
      console.log(`[0agent] Project: ${projectContext.name || '(unnamed)'} [${projectContext.stack.join(', ')}]`);
    }

    // 5.6 — Collab-3: initialize team manager + sync
    const teamManager = new TeamManager();
    const teams = teamManager.getMemberships();
    if (teams.length > 0) {
      console.log(`[0agent] Teams: ${teams.map(t => t.team_name).join(', ')}`);
    }

    // 6. Create SessionManager
    this.eventBus = new WebSocketEventBus();
    this.sessionManager = new SessionManager({
      inferenceEngine: this.inferenceEngine,
      eventBus: this.eventBus,
      graph: this.graph,
      llm: llmExecutor,
      cwd,
      identity: identity ?? undefined,
      projectContext: projectContext ?? undefined,
      adapter: this.adapter,   // enables ConversationStore + weight feedback
    });

    // 6.5 — Collab-3: team sync worker (only if member of teams)
    const teamSync = identity && teams.length > 0
      ? new TeamSync(teamManager, this.adapter, identity.entity_node_id)
      : null;

    // 6.6 — Collab-2: ProactiveSurface loaded lazily (file may not exist yet)
    let proactiveSurface = null;
    try {
      const { ProactiveSurface } = await import('./ProactiveSurface.js');
      proactiveSurface = new ProactiveSurface(this.graph, this.eventBus, cwd);
    } catch {
      // Collab-2 not yet built — skip silently
    }

    // 7. Create BackgroundWorkers, start them
    this.backgroundWorkers = new BackgroundWorkers({
      graph: this.graph,
      traceStore: this.traceStore,
      ...(proactiveSurface ? { proactiveSurface } : {}),
      ...(teamSync ? { teamSync } : {}),
    });
    this.backgroundWorkers.start();

    // 7. WebSocketEventBus already created above; start heartbeat
    this.eventBus.startStatsHeartbeat(() => ({
      graph_nodes: this.graph!.nodeCount(),
      active_sessions: this.sessionManager!.activeSessionCount(),
    }));

    // 8. Create HTTPServer, start it
    this.startedAt = Date.now();
    this.httpServer = new HTTPServer({
      port: this.config.server.port,
      host: this.config.server.host,
      sessions: this.sessionManager,
      graph: this.graph,
      traceStore: this.traceStore,
      skillRegistry: this.skillRegistry,
      getStatus: () => this.getStatus(),
    });
    await this.httpServer.start();

    // 9. Write PID file
    writeFileSync(this.pidFilePath, String(process.pid), 'utf8');

    // 10. Log startup
    console.log(
      `[0agent] Daemon started on ${this.config.server.host}:${this.config.server.port} (PID: ${process.pid})`,
    );

    // 11. Register SIGTERM/SIGINT handlers
    const shutdown = async () => {
      console.log('[0agent] Shutting down...');
      await this.stop();
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  }

  async stop(): Promise<void> {
    // Graceful shutdown in reverse order
    if (this.httpServer) {
      await this.httpServer.stop();
      this.httpServer = null;
    }

    if (this.eventBus) {
      this.eventBus.stopStatsHeartbeat();
      this.eventBus = null;
    }

    if (this.backgroundWorkers) {
      this.backgroundWorkers.stop();
      this.backgroundWorkers = null;
    }

    this.sessionManager = null;
    this.skillRegistry = null;
    this.inferenceEngine = null;
    this.traceStore = null;

    if (this.graph) {
      this.graph.close();
      this.graph = null;
    }

    this.adapter = null;

    // Remove PID file
    if (existsSync(this.pidFilePath)) {
      try {
        unlinkSync(this.pidFilePath);
      } catch {
        // Ignore cleanup errors
      }
    }

    console.log('[0agent] Daemon stopped.');
  }

  getStatus(): DaemonStatus {
    const runningWorkers: string[] = [];
    if (this.backgroundWorkers?.isRunning()) {
      const statuses = this.backgroundWorkers.getWorkerStatus();
      for (const ws of statuses) {
        if (ws.active) runningWorkers.push(ws.name);
      }
    }

    return {
      version: '2.0.0',
      uptime_ms: this.startedAt ? Date.now() - this.startedAt : 0,
      graph_nodes: this.graph?.nodeCount() ?? 0,
      graph_edges: this.graph?.edgeCount() ?? 0,
      active_sessions: this.sessionManager?.activeSessionCount() ?? 0,
      mcp_servers_connected: 0,
      workers_running: runningWorkers,
      sandbox_backend: this.config?.sandbox.backend ?? 'auto',
    };
  }
}
