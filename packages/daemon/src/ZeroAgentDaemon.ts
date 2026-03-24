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
import { GitHubMemorySync } from './GitHubMemorySync.js';
import { CodespaceManager } from './CodespaceManager.js';
import { SchedulerManager } from './SchedulerManager.js';
import { RuntimeSelfHeal } from './RuntimeSelfHeal.js';
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
  private githubMemorySync: GitHubMemorySync | null = null;
  private memorySyncTimer: ReturnType<typeof setInterval> | null = null;
  private proactiveSurfaceInstance: unknown = null;
  private codespaceManager: CodespaceManager | null = null;
  private schedulerManager: SchedulerManager | null = null;
  private runtimeHealer: RuntimeSelfHeal | null = null;
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

    // 5.0 — GitHub memory sync: pull on startup if configured
    const ghMemCfg = (this.config as Record<string, unknown>)['github_memory'] as
      { enabled?: boolean; token?: string; owner?: string; repo?: string } | undefined;
    if (ghMemCfg?.enabled && ghMemCfg.token && ghMemCfg.owner && ghMemCfg.repo) {
      this.githubMemorySync = new GitHubMemorySync(
        { token: ghMemCfg.token, owner: ghMemCfg.owner, repo: ghMemCfg.repo },
        this.adapter,
        this.graph,
      );
      console.log(`[0agent] Memory sync: github.com/${ghMemCfg.owner}/${ghMemCfg.repo}`);

      // Codespace manager uses the same memory repo as its template
      // Only init if gh CLI is authenticated
      if (CodespaceManager.isAvailable()) {
        const memRepo = `${ghMemCfg.owner}/${ghMemCfg.repo}`;
        this.codespaceManager = new CodespaceManager(memRepo);
        // Pre-warm in background — by the time user needs browser, it may be ready
        this.codespaceManager.getReadyUrl().catch(() => {
          // Non-fatal — codespace warmup is best-effort at startup
        });
        console.log(`[0agent] Browser backend: github.com codespace (from ${memRepo})`);
      }
      // Pull in background — don't block startup
      this.githubMemorySync.pull().then(r => {
        if (r.pulled) console.log(`[0agent] Memory pulled: +${r.nodes_synced} nodes, +${r.edges_synced} edges`);
      }).catch(() => {});
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

    // 6.5.5 — GitHub memory: auto-push every 30 minutes if dirty
    if (this.githubMemorySync) {
      const memSync = this.githubMemorySync;
      this.memorySyncTimer = setInterval(async () => {
        if (memSync.hasPendingChanges()) {
          const result = await memSync.push().catch(() => null);
          if (result?.pushed) {
            console.log(`[0agent] Memory auto-synced: ${result.nodes_synced} nodes`);
          }
        }
      }, 30 * 60 * 1000); // 30 minutes
      if (typeof this.memorySyncTimer === 'object') (this.memorySyncTimer as any).unref?.();
    }

    // 6.6 — Collab-2: ProactiveSurface loaded lazily (file may not exist yet)
    let proactiveSurface = null;
    try {
      const { ProactiveSurface } = await import('./ProactiveSurface.js');
      proactiveSurface = new ProactiveSurface(this.graph, this.eventBus, cwd);
    } catch {
      // Collab-2 not yet built — skip silently
    }

    // 6.7 — Runtime self-healer (needs LLM + eventBus)
    if (llmExecutor?.isConfigured) {
      this.runtimeHealer = new RuntimeSelfHeal(llmExecutor, this.eventBus);
      // Catch unhandled exceptions and offer to self-heal
      process.on('uncaughtException', (err) => {
        const stack = err.stack ?? err.message;
        console.error('[0agent] Uncaught exception:', stack);
        this.runtimeHealer?.analyze(stack, 'daemon runtime').then(proposal => {
          if (proposal && this.eventBus) {
            this.runtimeHealer?.emitProposal(proposal);
            // Also store it so /api/runtime/proposals returns it
            fetch(`http://127.0.0.1:${this.config!.server.port}/api/runtime/proposals`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(proposal),
            }).catch(() => {});
          }
        }).catch(() => {});
      });
    }

    // 6.8 — Scheduler: create after sessionManager (needs it to fire jobs)
    this.schedulerManager = new SchedulerManager(this.adapter, this.sessionManager, this.eventBus);
    this.schedulerManager.start();

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
    const memSyncRef = this.githubMemorySync;
    this.httpServer = new HTTPServer({
      port: this.config.server.port,
      host: this.config.server.host,
      sessions: this.sessionManager,
      graph: this.graph,
      traceStore: this.traceStore,
      skillRegistry: this.skillRegistry,
      getStatus: () => this.getStatus(),
      getMemorySync: () => memSyncRef,
      proactiveSurface: proactiveSurface as any,
      getCodespaceManager: () => this.codespaceManager,
      scheduler: this.schedulerManager,
      healer: this.runtimeHealer,
      setupCodespace: async () => {
        if (!this.codespaceManager) return { started: false, error: 'GitHub memory not configured. Run: 0agent memory connect github' };
        try {
          // Provision in background — returns immediately
          this.codespaceManager.getReadyUrl().catch(console.error);
          return { started: true };
        } catch (err) {
          return { started: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
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

    // Final push on shutdown — capture last session's learning
    if (this.githubMemorySync?.hasPendingChanges()) {
      await this.githubMemorySync.push('sync: daemon shutdown').catch(() => {});
    }
    if (this.memorySyncTimer) { clearInterval(this.memorySyncTimer); this.memorySyncTimer = null; }
    this.githubMemorySync = null;
    this.schedulerManager?.stop();
    this.schedulerManager = null;
    this.codespaceManager?.closeTunnel();
    this.codespaceManager = null;

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
