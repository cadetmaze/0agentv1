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
import { WeightEventLog, EdgeWeightUpdater } from '@0agent/core';

import type { IEventBus } from './WebSocketEvents.js';
import { EntityScopedContextLoader } from './EntityScopedContext.js';
import type { LLMExecutor } from './LLMExecutor.js';
import { AgentExecutor } from './AgentExecutor.js';
import { AnthropicSkillFetcher } from './AnthropicSkillFetcher.js';
import type { UserIdentity } from './IdentityManager.js';
import { ProjectScanner, type ProjectContext } from './ProjectScanner.js';
import { ConversationStore } from './ConversationStore.js';

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
  identity?: UserIdentity;              // Collab-1: who is running sessions
  projectContext?: ProjectContext;      // Collab-1: what project we're in
  adapter?: SQLiteAdapter;             // for ConversationStore + WeightEventLog
}

// ─── SessionManager ──────────────────────────────────

export class SessionManager {
  private sessions: Map<string, Session> = new Map();
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

  constructor(deps: SessionManagerDeps = {}) {
    this.inferenceEngine = deps.inferenceEngine;
    this.eventBus = deps.eventBus;
    this.graph = deps.graph;
    this.llm = deps.llm;
    this.cwd = deps.cwd ?? process.cwd();
    this.identity = deps.identity;
    this.projectContext = deps.projectContext;

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
      session_id: session.id,
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
      session_id: session.id,
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
      session_id: session.id,
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
      session_id: session.id,
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

    this.emit({
      type: 'session.failed',
      session_id: session.id,
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

    try {
      await this.startSession(session.id);

      // Step 1: entity extraction
      this.addStep(session.id, `Extracting entities from: "${req.task.slice(0, 60)}${req.task.length > 60 ? '…' : ''}"`);

      // Step 2: graph query
      this.addStep(session.id, 'Querying knowledge graph (structural + semantic)…');

      // Step 3: plan selection result
      if (session.plan) {
        const edge = session.plan.selected_edge;
        if (edge) {
          this.addStep(session.id,
            `Selected plan: ${edge.from_label} → ${edge.to_label} (weight: ${edge.weight.toFixed(2)}, mode: ${edge.mode})`,
            session.plan,
          );
        } else {
          this.addStep(session.id, `No prior plan found — bootstrapping from scratch`, session.plan);
        }

        // Step 4: skill match
        if (session.plan.skill) {
          this.addStep(session.id, `Matched skill: /${session.plan.skill}`);
        }
      } else {
        this.addStep(session.id, 'No inference engine connected — executing task directly');
      }

      // Step 4.5: if skill matches an Anthropic skill, fetch instructions at runtime
      let anthropicContext: string | undefined;
      if (enrichedReq.skill && this.anthropicFetcher.isAnthropicSkill(enrichedReq.skill)) {
        this.addStep(session.id, `Fetching skill instructions: ${enrichedReq.skill}`);
        const fetched = await this.anthropicFetcher.fetch(enrichedReq.skill);
        if (fetched) {
          anthropicContext = this.anthropicFetcher.buildSystemPrompt(fetched);
          this.addStep(session.id, `Loaded skill: ${fetched.name} (${fetched.cached ? 'cached' : 'fresh'})`);
        }
      }

      // Step 5: execute via AgentExecutor (real tool calling + streaming)
      if (this.llm?.isConfigured) {
        const executor = new AgentExecutor(
          this.llm,
          { cwd: this.cwd },
          // step callback → emit session.step events
          (step) => this.addStep(session.id, step),
          // token callback → emit session.token events
          (token) => this.emit({ type: 'session.token', session_id: session.id, token }),
        );

        // Merge all context layers (Collab-1 identity + project + Anthropic skill + entity personality)
        const identityContext = this.identity
          ? `You are talking to ${this.identity.name} (device: ${this.identity.device_id}, timezone: ${this.identity.timezone}).`
          : undefined;
        const projectCtx = this.projectContext
          ? ProjectScanner.buildContextPrompt(this.projectContext)
          : undefined;

        // Conversation history — the key to "make it dark mode" understanding "it"
        const userEntityId = enrichedReq.entity_id ?? this.identity?.entity_node_id;
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

        // Use SelfHealLoop if available (Collab-2), otherwise bare executor
        let agentResult: Awaited<ReturnType<typeof executor.execute>>;
        try {
          const { SelfHealLoop } = await import('./SelfHealLoop.js');
          const healLoop = new SelfHealLoop(
            this.llm,
            { cwd: this.cwd },
            (step) => this.addStep(session.id, step),
            (token) => this.emit({ type: 'session.token', session_id: session.id, token }),
          );
          agentResult = await healLoop.executeWithHealing(enrichedReq.task, systemContext);
        } catch {
          // SelfHealLoop not yet available — use bare executor
          agentResult = await executor.execute(enrichedReq.task, systemContext);
        }

        // ── Store conversation exchange (makes follow-up requests work) ──────
        if (this.conversationStore && userEntityId) {
          const sessionId = session.id;
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
        const selectedEdgeId = session.plan?.selected_edge?.edge_id;
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
                session.id
              );
              this.emit({ type: 'graph.weight_updated', edge_id: edge.id, old_weight: edge.weight, new_weight: newWeight });
            }
          }
        }

        // Final summary step
        if (agentResult.files_written.length > 0) {
          this.addStep(session.id, `Files written: ${agentResult.files_written.join(', ')}`);
        }
        if (agentResult.commands_run.length > 0) {
          this.addStep(session.id, `Commands run: ${agentResult.commands_run.length}`);
        }
        this.addStep(session.id, `Done (${agentResult.tokens_used} tokens, ${agentResult.iterations} LLM turns)`);

        this.completeSession(session.id, {
          output: agentResult.output,
          files_written: agentResult.files_written,
          commands_run: agentResult.commands_run,
          tokens_used: agentResult.tokens_used,
          model: agentResult.model,
        });
      } else {
        const output = session.plan?.reasoning ?? 'No LLM configured — add api_key to ~/.0agent/config.yaml';
        this.addStep(session.id, 'No LLM API key configured');
        this.completeSession(session.id, { output });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.failSession(session.id, message);
    }

    return this.sessions.get(session.id)!;
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
}

