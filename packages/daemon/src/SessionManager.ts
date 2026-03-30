/**
 * SessionManager — Phase 2 session lifecycle manager.
 *
 * Manages concurrent sessions, creates traces, delegates to InferenceEngine.
 */

import type {
  KnowledgeGraph,
  TraceStore,
  TraceRecord,
  InferencePlan,
  IInferenceEngine,
  SQLiteAdapter,
} from '@0agent/core';
import { WeightEventLog, EdgeWeightUpdater, NodeType, EdgeType, createNode } from '@0agent/core';

import type { IEventBus } from './WebSocketEvents.js';
import { EntityScopedContextLoader } from './EntityScopedContext.js';
import { LLMExecutor } from './LLMExecutor.js';
import { AgentExecutor } from './AgentExecutor.js';
import { AnthropicSkillFetcher } from './AnthropicSkillFetcher.js';
import type { UserIdentity } from './IdentityManager.js';
import { ProjectScanner, type ProjectContext } from './ProjectScanner.js';
import { ConversationStore } from './ConversationStore.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import YAML from 'yaml';

// ─── Types ───────────────────────────────────────────

export interface Session {
  id: string;
  task: string;
  skill?: string;
  entity_id?: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  created_at: number;
  started_at?: number;
  completed_at?: number;
  result?: unknown;
  error?: string;
  trace_id?: string;
  plan?: InferencePlan;
  steps: SessionStep[];
}

export interface SessionStep {
  index: number;
  description: string;
  result?: unknown;
  started_at: number;
  completed_at?: number;
}

export interface CreateSessionRequest {
  task: string;
  skill?: string;
  entity_id?: string;
  context?: Record<string, unknown>;
  options?: { max_steps?: number; timeout_ms?: number };
}

export interface SessionManagerDeps {
  inferenceEngine?: IInferenceEngine;
  eventBus?: IEventBus;
  graph?: KnowledgeGraph;
  llm?: LLMExecutor;
  cwd?: string;
  identity?: UserIdentity;
  projectContext?: ProjectContext;
  adapter?: SQLiteAdapter;
  agentRoot?: string;        // path to 0agent source for self-improvement tasks
  onMemoryWritten?: () => void; // called when facts are persisted → triggers GitHub sync
}

// ─── SessionManager ──────────────────────────────────

export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private abortControllers: Map<string, AbortController> = new Map();
  private inferenceEngine?: IInferenceEngine;
  private eventBus?: IEventBus;
  private graph?: KnowledgeGraph;
  private llm?: LLMExecutor;
  private cwd: string;
  private identity?: UserIdentity;
  private projectContext?: ProjectContext;
  private conversationStore?: ConversationStore;
  private weightUpdater?: EdgeWeightUpdater;
  private anthropicFetcher = new AnthropicSkillFetcher();
  private agentRoot?: string;
  private onMemoryWritten?: () => void;

  constructor(deps: SessionManagerDeps = {}) {
    this.inferenceEngine = deps.inferenceEngine;
    this.eventBus = deps.eventBus;
    this.graph = deps.graph;
    this.llm = deps.llm;
    this.cwd = deps.cwd ?? process.cwd();
    this.identity = deps.identity;
    this.projectContext = deps.projectContext;
    this.agentRoot = deps.agentRoot;
    this.onMemoryWritten = deps.onMemoryWritten;

    if (deps.adapter) {
      // Conversation history — so "make it dark mode" knows what "it" is
      this.conversationStore = new ConversationStore(deps.adapter);
      this.conversationStore.init();

      // Outcome→weight feedback — so the graph actually learns from real tasks
      const wLog = new WeightEventLog(deps.adapter);
      this.weightUpdater = new EdgeWeightUpdater(deps.adapter, wLog);
    }
  }

  /**
   * Create a new session with status 'pending'.
   */
  createSession(req: CreateSessionRequest): Session {
    const id = crypto.randomUUID();
    const session: Session = {
      id,
      task: req.task,
      skill: req.skill,
      entity_id: req.entity_id,
      status: 'pending',
      created_at: Date.now(),
      steps: [],
    };
    this.sessions.set(id, session);
    return session;
  }

  /**
   * Transition session to 'running' and optionally invoke inference engine.
   */
  async startSession(id: string): Promise<Session> {
    const session = this.getSessionOrThrow(id);
    session.status = 'running';
    session.started_at = Date.now();

    this.emit({
      type: 'session.started',
      session_id: id,
      task: session.task,
    });

    if (this.inferenceEngine) {
      try {
        const plan = await this.inferenceEngine.resolve(session.task);
        session.plan = plan;
        if (plan.skill) {
          session.skill = plan.skill;
        }
      } catch {
        // Inference failure is non-fatal at start; session continues.
      }
    }

    return session;
  }

  /**
   * Append a step to a running session.
   */
  addStep(id: string, description: string, result?: unknown): SessionStep {
    const session = this.getSessionOrThrow(id);
    const step: SessionStep = {
      index: session.steps.length,
      description,
      result,
      started_at: Date.now(),
    };
    session.steps.push(step);

    this.emit({
      type: 'session.step',
      session_id: id,
      step: description,
      result: result ?? null,
    });

    return step;
  }

  /**
   * Mark session as completed with a result.
   */
  completeSession(id: string, result?: unknown): Session {
    const session = this.getSessionOrThrow(id);
    session.status = 'completed';
    session.completed_at = Date.now();
    session.result = result;

    this.emit({
      type: 'session.completed',
      session_id: id,
      result: result ?? null,
    });

    return session;
  }

  /**
   * Mark session as failed with an error message.
   */
  failSession(id: string, error: string): Session {
    const session = this.getSessionOrThrow(id);
    session.status = 'failed';
    session.completed_at = Date.now();
    session.error = error;

    this.emit({
      type: 'session.failed',
      session_id: id,
      error,
    });

    return session;
  }

  /**
   * Cancel a session.
   */
  cancelSession(id: string): Session {
    const session = this.getSessionOrThrow(id);
    session.status = 'cancelled';
    session.completed_at = Date.now();
    session.error = 'cancelled';

    // Abort any in-flight LLM call for this session
    const controller = this.abortControllers.get(id);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(id);
    }

    this.emit({
      type: 'session.failed',
      session_id: id,
      error: 'cancelled',
    });

    return session;
  }

  /**
   * Get session by ID, or null if not found.
   */
  getSession(id: string): Session | null {
    return this.sessions.get(id) ?? null;
  }

  /**
   * List all sessions sorted by created_at descending.
   */
  listSessions(): Session[] {
    return [...this.sessions.values()].sort(
      (a, b) => b.created_at - a.created_at,
    );
  }

  /**
   * End-to-end session run: create -> start -> resolve -> step -> complete.
   * Wraps everything in try/catch to fail gracefully.
   */
  /**
   * Called by the route AFTER it already created the session.
   * Uses the existing session ID — no duplicate creation.
   */
  async runExistingSession(sessionId: string, req: CreateSessionRequest): Promise<Session> {
    return this._executeSession(sessionId, req);
  }

  /** @deprecated Use runExistingSession from routes — this creates a duplicate session. */
  async runSession(req: CreateSessionRequest): Promise<Session> {
    // Resolve entity-scoped context before creating the session so the
    // personality_prompt can be prepended to the task's system context.
    let enrichedReq = req;
    if (req.entity_id && this.graph) {
      const loader = new EntityScopedContextLoader(this.graph);
      const scopedCtx = loader.load(req.entity_id);
      if (scopedCtx?.personality_prompt) {
        enrichedReq = {
          ...req,
          context: {
            ...req.context,
            system_context: [
              scopedCtx.personality_prompt,
              ...(req.context?.system_context != null
                ? [String(req.context.system_context)]
                : []),
            ].join('\n\n'),
            entity_label: scopedCtx.entity_label,
            parent_entity_labels: scopedCtx.parent_entity_labels,
          },
        };
      }
    }

    const session = this.createSession(enrichedReq);
    return this._executeSession(session.id, enrichedReq);
  }

  /**
   * Core execution — takes an EXISTING session ID and runs it.
   * All callers must have created the session first.
   */
  private async _executeSession(sessionId: string, enrichedReq: CreateSessionRequest): Promise<Session> {
    const abortController = new AbortController();
    this.abortControllers.set(sessionId, abortController);
    const signal = abortController.signal;

    try {
      await this.startSession(sessionId);

      // Step 1: entity extraction
      this.addStep(sessionId, `Extracting entities from: "${enrichedReq.task.slice(0, 60)}${enrichedReq.task.length > 60 ? '…' : ''}"`);

      // Step 2: graph query
      this.addStep(sessionId, 'Querying knowledge graph (structural + semantic)…');

      // Step 3: plan selection result
      const plan = this.getSession(sessionId)?.plan;
      if (plan) {
        const edge = plan.selected_edge;
        if (edge) {
          this.addStep(sessionId,
            `Selected plan: ${edge.from_label} → ${edge.to_label} (weight: ${edge.weight.toFixed(2)}, mode: ${edge.mode})`,
            plan,
          );
        } else {
          this.addStep(sessionId, `No prior plan found — bootstrapping from scratch`, plan);
        }
        if (plan.skill) {
          this.addStep(sessionId, `Matched skill: /${plan.skill}`);
        }
      } else {
        this.addStep(sessionId, 'No inference engine connected — executing task directly');
      }

      // Step 4.5: if skill matches an Anthropic skill, fetch instructions at runtime
      let anthropicContext: string | undefined;
      if (enrichedReq.skill && this.anthropicFetcher.isAnthropicSkill(enrichedReq.skill)) {
        this.addStep(sessionId, `Fetching skill instructions: ${enrichedReq.skill}`);
        const fetched = await this.anthropicFetcher.fetch(enrichedReq.skill);
        if (fetched) {
          anthropicContext = this.anthropicFetcher.buildSystemPrompt(fetched);
          this.addStep(sessionId, `Loaded skill: ${fetched.name} (${fetched.cached ? 'cached' : 'fresh'})`);
        }
      }

      // Step 5: execute via AgentExecutor (real tool calling + streaming)
      const activeLLM = this.getFreshLLM();  // always latest key from config
      if (activeLLM?.isConfigured) {
        const userEntityId = enrichedReq.entity_id ?? this.identity?.entity_node_id;

        // ── Fast path: conversational messages skip tools, system prompt, and all graph writes ──
        // Saves ~3000 tokens per greeting by bypassing AgentExecutor entirely.
        const isConversational = /^(hey|hi|hello|sup|yo|what'?s up|how are you|thanks|ok|cool|bye|good\s+(morning|evening|afternoon)|lol|nice)[!?.\s,]*$/i.test(enrichedReq.task.trim());
        if (isConversational) {
          const resp = await activeLLM.complete(
            [{ role: 'user', content: enrichedReq.task }],
            'You are a helpful assistant.',
          );
          this.emit({ type: 'session.token', session_id: sessionId, token: resp.content });
          this.addStep(sessionId, `Done (${resp.tokens_used} tokens, 1 LLM turns)`);
          this.completeSession(sessionId, {
            output: resp.content,
            files_written: [],
            commands_run: [],
            tokens_used: resp.tokens_used,
            model: resp.model,
          });
          return this.sessions.get(sessionId)!;
        }

        const executor = new AgentExecutor(
          activeLLM,
          { cwd: this.cwd, agent_root: this.agentRoot, graph: this.graph, onMemoryWrite: this.onMemoryWritten, entityNodeId: userEntityId },
          // step callback → emit session.step events
          (step) => this.addStep(sessionId, step),
          // token callback → emit session.token events
          (token) => this.emit({ type: 'session.token', session_id: sessionId, token }),
        );

        // Merge all context layers (Collab-1 identity + project + Anthropic skill + entity personality)
        const identityContext = this.identity
          ? `You are talking to ${this.identity.name} (device: ${this.identity.device_id}, timezone: ${this.identity.timezone}).`
          : undefined;
        const projectCtx = this.projectContext
          ? ProjectScanner.buildContextPrompt(this.projectContext)
          : undefined;

        // Conversation history — the key to "make it dark mode" understanding "it"
        let conversationHistory: string | undefined;
        if (this.conversationStore && userEntityId) {
          const history = this.conversationStore.buildContextMessages(userEntityId, 8);
          if (history.length > 0) {
            const historyStr = history
              .map(m => `${m.role === 'user' ? 'User' : 'Agent'}: ${m.content.slice(0, 400)}`)
              .join('\n');
            conversationHistory = `CONVERSATION HISTORY (use this for context on follow-up requests):\n${historyStr}\n\nCurrent task:`;
          }
        }

        const systemContext = [
          identityContext,
          projectCtx,
          conversationHistory,
          anthropicContext,
          enrichedReq.context?.system_context
            ? String(enrichedReq.context.system_context)
            : undefined,
        ].filter(Boolean).join('\n\n') || undefined;

        // Use SelfHealLoop if available (Collab-2), otherwise bare executor.
        // CRITICAL: pass full config including graph + onMemoryWrite so
        // memory_write tool is available and the callback chain works.
        const fullConfig = {
          cwd: this.cwd,
          agent_root: this.agentRoot,
          graph: this.graph,
          onMemoryWrite: this.onMemoryWritten,
          entityNodeId: userEntityId,
        };
        let agentResult: Awaited<ReturnType<typeof executor.execute>>;
        try {
          const { SelfHealLoop } = await import('./SelfHealLoop.js');
          const healLoop = new SelfHealLoop(
            activeLLM,
            fullConfig,
            (step) => this.addStep(sessionId, step),
            (token) => this.emit({ type: 'session.token', session_id: sessionId, token }),
          );
          agentResult = await healLoop.executeWithHealing(enrichedReq.task, systemContext, signal);
        } catch {
          // SelfHealLoop not yet available — use bare executor
          agentResult = await executor.execute(enrichedReq.task, systemContext, signal);
        }

        // ── Store conversation exchange (makes follow-up requests work) ──────
        if (this.conversationStore && userEntityId) {
          // sessionId already defined
          const now = Date.now();
          this.conversationStore.append({
            id: crypto.randomUUID(),
            session_id: sessionId,
            user_entity_id: userEntityId,
            role: 'user',
            content: enrichedReq.task,
            created_at: now,
          });
          this.conversationStore.append({
            id: crypto.randomUUID(),
            session_id: sessionId,
            user_entity_id: userEntityId,
            role: 'assistant',
            content: agentResult.output.slice(0, 1000), // cap stored output length
            created_at: now + 1,
          });
        }

        // ── Outcome → weight feedback (graph learns from real task outcomes) ──
        const selectedEdgeId = this.getSession(sessionId)?.plan?.selected_edge?.edge_id;
        if (selectedEdgeId && this.weightUpdater && this.graph) {
          const outcomeSignal = this.computeOutcomeSignal(agentResult as unknown as Record<string, unknown>);
          if (outcomeSignal !== 0) {
            const edge = this.graph.getEdge(selectedEdgeId);
            if (edge && !edge.locked) {
              const newWeight = Math.max(0.0, Math.min(1.0,
                edge.weight + outcomeSignal * 0.1  // learning rate 0.1
              ));
              await this.weightUpdater.update(
                edge.id, edge.weight, newWeight,
                outcomeSignal > 0 ? 'task_outcome_positive' : 'task_outcome_negative',
                sessionId
              );
              this.emit({ type: 'graph.weight_updated', edge_id: edge.id, old_weight: edge.weight, new_weight: newWeight });
            }
          }
        }

        // Final summary step
        if (agentResult.files_written.length > 0) {
          this.addStep(sessionId, `Files written: ${agentResult.files_written.join(', ')}`);
        }
        if (agentResult.commands_run.length > 0) {
          this.addStep(sessionId, `Commands run: ${agentResult.commands_run.length}`);
        }
        this.addStep(sessionId, `Done (${agentResult.tokens_used} tokens, ${agentResult.iterations} LLM turns)`);

        // ── Guaranteed baseline write: session summary always hits the graph ──
        if (this.graph) {
          try {
            const nodeId = `memory:session_${sessionId.slice(0, 8)}`;
            const label  = enrichedReq.task.slice(0, 80);
            const existing = this.graph.getNode(nodeId);
            const meta = {
              task:       enrichedReq.task.slice(0, 300),
              output:     agentResult.output.slice(0, 300),
              type:       'session_summary',
              tokens:     agentResult.tokens_used,
              saved_at:   new Date().toISOString(),
            };
            if (existing) {
              this.graph.updateNode(nodeId, { label, metadata: meta });
            } else {
              this.graph.addNode(createNode({
                id: nodeId, graph_id: 'root', label, type: NodeType.CONTEXT, metadata: meta,
              }));
              // Connect session summary → user entity
              if (userEntityId) {
                this._ensureEdge(userEntityId, nodeId);
              }
            }
            console.log(`[0agent] Graph: wrote session summary node (${nodeId})`);
            this.onMemoryWritten?.();
          } catch (err) {
            console.warn('[0agent] Graph: baseline write failed:', err instanceof Error ? err.message : err);
          }
        }

        // Extract and persist factual entities from this conversation to long-term memory
        this._extractAndPersistFacts(enrichedReq.task, agentResult.output, activeLLM, userEntityId).catch((err) => {
          console.warn('[0agent] Memory extraction outer error:', err instanceof Error ? err.message : err);
        });

        this.completeSession(sessionId, {
          output: agentResult.output,
          files_written: agentResult.files_written,
          commands_run: agentResult.commands_run,
          tokens_used: agentResult.tokens_used,
          model: agentResult.model,
        });
      } else {
        const cfgPath = resolve(homedir(), '.0agent', 'config.yaml');
        const output = `No LLM API key found. Add one to ${cfgPath} or run: 0agent init`;
        this.addStep(sessionId, '⚠ No LLM API key configured — run: 0agent init');
        this.completeSession(sessionId, { output });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.failSession(sessionId, message);
    } finally {
      this.abortControllers.delete(sessionId);
    }

    return this.sessions.get(sessionId)!;
  }

  /**
   * Return the number of active (running) sessions.
   */
  activeSessionCount(): number {
    let count = 0;
    for (const s of this.sessions.values()) {
      if (s.status === 'running') count++;
    }
    return count;
  }

  // ─── Private helpers ───────────────────────────────

  private getSessionOrThrow(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Session not found: ${id}`);
    }
    return session;
  }

  private emit(event: Record<string, unknown>): void {
    if (this.eventBus) {
      this.eventBus.emit(event);
    }
  }

  /**
   * Always returns a fresh LLM executor with the latest API key from disk.
   * Fixes stale-daemon problem: if the user sets their key AFTER the daemon
   * started, the next session picks it up automatically.
   */
  private getFreshLLM(): LLMExecutor | undefined {
    try {
      const configPath = resolve(homedir(), '.0agent', 'config.yaml');
      if (!existsSync(configPath)) return this.llm;
      const raw = readFileSync(configPath, 'utf8');
      const cfg = YAML.parse(raw) as Record<string, unknown>;
      const providers = cfg.llm_providers as Array<Record<string, unknown>> | undefined;
      if (!providers?.length) return this.llm;
      const def = providers.find(p => p.is_default) ?? providers[0];
      if (!def) return this.llm;
      const freshExec = new LLMExecutor({
        provider: String(def.provider ?? 'anthropic'),
        model:    String(def.model    ?? 'claude-sonnet-4-6'),
        api_key:  String(def.api_key  ?? ''),
        base_url: def.base_url ? String(def.base_url) : undefined,
      });
      // If fresh exec has a key but stored one doesn't, use fresh
      if (freshExec.isConfigured) return freshExec;
    } catch {}
    return this.llm;
  }

  /**
   * After every session, run a lightweight LLM pass to extract factual entities
   * (name, projects, tech, preferences, URLs) and persist them to the graph.
   * This catches everything the agent didn't explicitly memory_write during execution.
   */
  private async _extractAndPersistFacts(task: string, output: string, _llm: LLMExecutor, entityId?: string): Promise<void> {
    if (!this.graph) return;

    // Use haiku for extraction — fast + cheap for background summarisation.
    // Read config fresh so we always have the latest key.
    let extractLLM: LLMExecutor | undefined;
    try {
      const cfgPath = resolve(homedir(), '.0agent', 'config.yaml');
      if (existsSync(cfgPath)) {
        const raw  = readFileSync(cfgPath, 'utf8');
        const cfg  = YAML.parse(raw) as Record<string, unknown>;
        const prov = (cfg.llm_providers as Array<Record<string,unknown>> | undefined)
          ?.find(p => p.is_default) ?? (cfg.llm_providers as any)?.[0];
        if (prov?.api_key && prov.provider === 'anthropic') {
          extractLLM = new LLMExecutor({
            provider: 'anthropic',
            model:    'claude-haiku-4-5-20251001',   // fast + cheap for extraction
            api_key:  String(prov.api_key),
          });
        } else if (prov?.api_key) {
          // Non-Anthropic provider — use whatever model they have configured
          extractLLM = new LLMExecutor({
            provider:  String(prov.provider),
            model:     String(prov.model),
            api_key:   String(prov.api_key),
            base_url:  prov.base_url ? String(prov.base_url) : undefined,
          });
        }
      }
    } catch {}

    if (!extractLLM?.isConfigured) return;

    // Skip trivial / command-only tasks that won't have learnable facts
    const combined = `${task} ${output}`;
    if (combined.trim().length < 20) return;

    const prompt = `Extract factual entities from this conversation that should be remembered long-term.
Return ONLY a valid JSON array (no markdown, no explanation), max 12 items.
If nothing worth remembering, return [].

Types: identity (name/role), project (apps/products), tech (stack/tools), preference, url, path, config, outcome

Format: [{"label":"snake_case_key","content":"value","type":"type"}]

Examples:
- "my name is Sahil" → {"label":"user_name","content":"Sahil","type":"identity"}
- "we have a telegram bot" → {"label":"project_telegram_bot","content":"user has a Telegram bot","type":"project"}
- "I use React and Next.js" → {"label":"tech_stack","content":"React, Next.js","type":"tech"}
- ngrok URL found → {"label":"ngrok_url","content":"https://abc.ngrok.io","type":"url"}

Conversation:
User: ${task.slice(0, 600)}
Agent: ${output.slice(0, 500)}`;

    try {
      const resp = await extractLLM.complete(
        [{ role: 'user', content: prompt }],
        'You are a memory extraction system. Be concise. Extract only factual, durable information. Return valid JSON only.'
      );

      // Parse robustly — find the JSON array anywhere in the response
      let entities: Array<{ label: string; content: string; type: string }> = [];
      const raw = resp.content.trim();

      // Try direct parse first
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) entities = parsed;
      } catch {
        // Try extracting array from the response
        const match = raw.match(/\[\s*\{[\s\S]*?\}\s*\]/);
        if (match) {
          try { entities = JSON.parse(match[0]); } catch {}
        }
      }

      if (!Array.isArray(entities) || entities.length === 0) return;

      let wrote = 0;
      for (const e of entities.slice(0, 12)) {
        if (!e?.label?.trim() || !e?.content?.trim()) continue;
        const nodeId = `memory:${e.label.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`;
        try {
          const existing = this.graph.getNode(nodeId);
          if (existing) {
            this.graph.updateNode(nodeId, {
              label: e.label,
              metadata: { ...existing.metadata, content: e.content, type: e.type ?? 'note', updated_at: new Date().toISOString() },
            });
          } else {
            this.graph.addNode(createNode({
              id: nodeId,
              graph_id: 'root',
              label: e.label,
              type: NodeType.CONTEXT,
              metadata: { content: e.content, type: e.type ?? 'note', saved_at: new Date().toISOString() },
            }));
            // Connect extracted fact → user entity
            if (entityId) {
              this._ensureEdge(entityId, nodeId);
            }
          }
          wrote++;
        } catch (err) {
          console.warn(`[0agent] Memory write failed for "${e.label}":`, err instanceof Error ? err.message : err);
        }
      }

      if (wrote > 0) {
        console.log(`[0agent] Memory: persisted ${wrote} facts → graph`);
        this.onMemoryWritten?.();
      }
    } catch (err) {
      // Non-fatal — log for debugging
      console.warn('[0agent] Memory extraction failed:', err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Convert a task result into a weight signal for the knowledge graph.
   *
   * Signal scale: -0.3 (failed after retries) to +0.3 (verified success first try).
   * Neutral (0) when no verification was possible — don't penalise unverifiable tasks.
   */
  private computeOutcomeSignal(result: Record<string, unknown>): number {
    const healAttempts = result['heal_attempts'] as Array<Record<string, unknown>> | undefined;
    if (!healAttempts || healAttempts.length === 0) return 0;

    const last = healAttempts[healAttempts.length - 1];
    const verification = last?.['verification'] as Record<string, unknown> | undefined;
    if (!verification || verification['method'] === 'none') return 0;

    const success = verification['success'] === true;
    const healed = result['healed'] === true; // succeeded only after retry

    if (success) return healed ? 0.1 : 0.3;  // retry = partial credit
    return -0.2;                               // all attempts failed
  }

  /** Create an edge between two nodes if it doesn't already exist. */
  private _ensureEdge(fromId: string, toId: string): void {
    if (!this.graph) return;
    try {
      const edgeId = `edge:${fromId}→${toId}`;
      if (this.graph.getEdge(edgeId)) return;
      this.graph.addEdge({
        id: edgeId,
        graph_id: 'root',
        from_node: fromId,
        to_node: toId,
        type: EdgeType.PRODUCES,
        weight: 0.8,
        locked: false,
        decay_rate: 0.001,
        created_at: Date.now(),
        last_traversed: null,
        traversal_count: 0,
        metadata: {},
      });
    } catch {
      // Non-fatal
    }
  }
}

