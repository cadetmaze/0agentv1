import { randomUUID } from 'node:crypto';
import type { KnowledgeGraph, ObjectStore, SkillDefinition } from '@0agent/core';
import type { MCPHub } from '@0agent/mcp-hub';
import type { CapabilityToken, TaskType, TokenIssueRequest } from './CapabilityToken.js';
import type { SubagentResult } from './SubagentResult.js';
import type { SandboxManager, SandboxCreateConfig, SandboxHandle } from './sandbox/SandboxManager.js';
import { issueToken } from './CapabilityToken.js';
import { errorResult } from './SubagentResult.js';
import { Watchdog } from './Watchdog.js';
import { RESOURCE_DEFAULTS } from './ResourceDefaults.js';

// ─── Interfaces ─────────────────────────────────────────

export interface OrchestratorConfig {
  daemon_secret: string;
  default_sandbox_type?: string;
}

export interface SpawnRequest {
  session_id: string;
  task: string;
  task_type: TaskType;
  system_prompt?: string;
  context?: Record<string, unknown>;
  skill?: SkillDefinition;
}

export interface IEventBus {
  emit(event: Record<string, unknown>): void;
}

// ─── Orchestrator ───────────────────────────────────────

const INPUT_SENTINEL = '__PAYLOAD_END__';
const OUTPUT_SENTINEL = '__OUTPUT_END__';

export class SubagentOrchestrator {
  private readonly sandboxManager: SandboxManager;
  private readonly mcpHub: MCPHub;
  private readonly graph: KnowledgeGraph | undefined;
  private readonly objectStore: ObjectStore | undefined;
  private readonly eventBus: IEventBus | undefined;
  private readonly config: OrchestratorConfig;
  private readonly activeSubagents: Set<string> = new Set();

  constructor(
    sandboxManager: SandboxManager,
    mcpHub: MCPHub,
    graph: KnowledgeGraph | undefined,
    objectStore: ObjectStore | undefined,
    eventBus: IEventBus | undefined,
    config: OrchestratorConfig,
  ) {
    this.sandboxManager = sandboxManager;
    this.mcpHub = mcpHub;
    this.graph = graph;
    this.objectStore = objectStore;
    this.eventBus = eventBus;
    this.config = config;
  }

  /**
   * Spawn a subagent through the full lifecycle:
   * token issuance -> sandbox creation -> execution -> cleanup
   */
  async spawn(req: SpawnRequest): Promise<SubagentResult> {
    const subagentId = randomUUID();
    const startedAt = Date.now();
    let sandbox: SandboxHandle | null = null;
    let watchdog: Watchdog | null = null;

    try {
      // 1. Issue capability token
      const tokenReq = this.buildTokenRequest(subagentId, req);
      const token = issueToken(tokenReq, this.config.daemon_secret);

      // 2. Emit spawned event
      this.eventBus?.emit({
        type: 'subagent.spawned',
        subagent_id: subagentId,
        tools: token.allowed_tools,
      });

      // 3. Track active subagent
      this.activeSubagents.add(subagentId);

      // 4. Build sandbox config and create sandbox
      const sandboxConfig = this.buildSandboxConfig(token, req);
      sandbox = await this.sandboxManager.create(
        sandboxConfig,
        this.config.default_sandbox_type,
      );

      // 5. Start watchdog
      watchdog = new Watchdog(subagentId, token.max_duration_ms, () => {
        sandbox?.kill().catch(() => {});
      });
      watchdog.start();

      // 6. Write payload to sandbox stdin
      const payload = JSON.stringify({
        token,
        task: req.task,
        system_prompt: req.system_prompt ?? '',
        context: req.context ?? {},
      });
      await sandbox.write(payload + '\n' + INPUT_SENTINEL + '\n');

      // 7. Read output from sandbox stdout
      const raw = await sandbox.readOutput();

      // 8. Parse output into SubagentResult
      const result = this.parseSubagentOutput(raw, subagentId, req.session_id, req.task);
      result.duration_ms = Date.now() - startedAt;

      // 9. Emit completed event
      this.eventBus?.emit({
        type: 'subagent.completed',
        subagent_id: subagentId,
        duration_ms: result.duration_ms,
      });

      return result;
    } catch (err: unknown) {
      return errorResult(subagentId, req.session_id, req.task, err, startedAt);
    } finally {
      // ALWAYS clean up
      watchdog?.cancel();
      this.activeSubagents.delete(subagentId);
      if (sandbox) {
        await this.sandboxManager.destroy(sandbox).catch(() => {});
      }
    }
  }

  /**
   * Returns the list of currently running subagent IDs.
   */
  getActiveSubagents(): string[] {
    return [...this.activeSubagents];
  }

  // ─── Helpers ────────────────────────────────────────

  /**
   * Parse JSON output from a subagent sandbox, handling malformed output gracefully.
   */
  parseSubagentOutput(
    raw: string,
    subagentId: string,
    sessionId: string,
    task: string,
  ): SubagentResult {
    // Strip output sentinel if present
    const cleaned = raw.replace(OUTPUT_SENTINEL, '').trim();

    if (!cleaned) {
      return {
        subagent_id: subagentId,
        session_id: sessionId,
        task,
        output: '',
        artifacts: [],
        tool_calls: [],
        llm_calls_used: 0,
        tokens_used: 0,
        tool_calls_count: 0,
        exit_reason: 'completed',
        duration_ms: 0,
      };
    }

    try {
      const parsed = JSON.parse(cleaned) as Partial<SubagentResult>;
      return {
        subagent_id: subagentId,
        session_id: sessionId,
        task,
        output: parsed.output ?? cleaned,
        artifacts: parsed.artifacts ?? [],
        tool_calls: parsed.tool_calls ?? [],
        llm_calls_used: parsed.llm_calls_used ?? 0,
        tokens_used: parsed.tokens_used ?? 0,
        tool_calls_count: parsed.tool_calls_count ?? 0,
        exit_reason: parsed.exit_reason ?? 'completed',
        duration_ms: parsed.duration_ms ?? 0,
        error: parsed.error,
      };
    } catch {
      // Malformed output — treat raw text as the output string
      return {
        subagent_id: subagentId,
        session_id: sessionId,
        task,
        output: cleaned,
        artifacts: [],
        tool_calls: [],
        llm_calls_used: 0,
        tokens_used: 0,
        tool_calls_count: 0,
        exit_reason: 'completed',
        duration_ms: 0,
      };
    }
  }

  /**
   * Convert a capability token's sandbox settings into a SandboxCreateConfig.
   */
  private buildSandboxConfig(
    token: CapabilityToken,
    req: SpawnRequest,
  ): SandboxCreateConfig {
    const defaults = RESOURCE_DEFAULTS[req.task_type];

    return {
      memory_mb: defaults.memory_mb,
      cpus: defaults.cpus,
      network: token.sandbox.network_access,
      network_allowlist: token.sandbox.network_allowlist,
      has_browser: token.sandbox.has_browser,
      has_display: token.sandbox.has_display,
      env: {
        SUBAGENT_ID: token.subagent_id,
        SESSION_ID: token.parent_session_id,
      },
      inject_files: [],
    };
  }

  /**
   * Build a TokenIssueRequest from a SpawnRequest, applying skill overrides when present.
   */
  private buildTokenRequest(
    subagentId: string,
    req: SpawnRequest,
  ): TokenIssueRequest {
    const tokenReq: TokenIssueRequest = {
      subagent_id: subagentId,
      parent_session_id: req.session_id,
      task_type: req.task_type,
    };

    // Apply skill overrides if a skill definition is provided
    if (req.skill) {
      const sp = req.skill.subagent;
      tokenReq.extra_tools = sp.tools;
      tokenReq.override_duration_ms = sp.duration_ms > 0 ? sp.duration_ms : undefined;

      tokenReq.graph_read_scope = {
        mode: sp.graph_scope.mode,
        entity_ids: sp.graph_scope.entity_ids,
      };

      tokenReq.sandbox_overrides = {
        type: sp.sandbox.type === 'auto' ? undefined : sp.sandbox.type,
        network_access: sp.sandbox.network_access,
        network_allowlist: sp.sandbox.network_allowlist,
        filesystem_access: sp.sandbox.filesystem_access,
        filesystem_scope: sp.sandbox.filesystem_scope,
        has_browser: sp.sandbox.has_browser,
      };
    }

    return tokenReq;
  }
}
