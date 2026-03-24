/**
 * InferenceEngine — Phase 4 full inference pipeline.
 *
 * Replaces the Phase 2 stub with:
 *   - Full entity resolution (pipeline or fallback)
 *   - Graph traversal with TraversalLedger recording
 *   - SelectionPolicy-based plan selection
 *   - Credit attribution and weight propagation on outcome
 *   - Skill metadata decoration
 *
 * The Phase 2 resolve() method is preserved for backward compatibility.
 */

import type { KnowledgeGraph } from '../graph/KnowledgeGraph.js';
import type { NodeResolutionService } from '../entity/NodeResolutionService.js';
import type { SelectionPolicy } from './SelectionPolicy.js';
import type { GraphEdge } from '../graph/GraphEdge.js';
import type { TraversalLedger } from '../trace/TraversalLedger.js';
import type { OutcomeTrace, AttributionResult } from '../trace/OutcomeTrace.js';
import type { WeightPropagation, OutcomeSignal } from './WeightPropagation.js';
import type { EdgeWeightUpdater } from '../concurrency/EdgeWeightUpdater.js';
import { NodeType } from '../graph/GraphNode.js';

// ─── Phase 2 interfaces (backward compat) ───────────────

export interface IInferenceEngine {
  resolve(
    task: string,
    context?: Record<string, unknown>,
  ): Promise<InferencePlan>;
}

export interface InferencePlan {
  task: string;
  resolved_entities: ResolvedEntity[];
  selected_edge: SelectedEdge | null;
  skill: string | null;
  confidence: number;
  reasoning: string;
}

export interface ResolvedEntity {
  mention: string;
  node_id: string;
  confidence: number;
  match_type: 'exact' | 'alias' | 'fuzzy' | 'created';
}

export interface SelectedEdge {
  edge_id: string;
  from_label: string;
  to_label: string;
  weight: number;
  mode: 'exploit' | 'explore';
}

// ─── Phase 4 interfaces ─────────────────────────────────

export interface InferenceRequest {
  input: string;
  session_id: string;
  context?: Record<string, unknown>;
  timeout_ms?: number;
}

export interface InferenceResult {
  output: string;
  trace_id: string;
  entities_resolved: string[];
  plan_selected: string[];
  subagent_result?: unknown;
  outcome_signal?: number;
  deferred: boolean;
}

/**
 * EntityResolutionPipeline contract — optional advanced pipeline.
 * When not provided, the engine falls back to NodeResolutionService.
 */
export interface EntityResolutionPipeline {
  extractAndResolve(
    input: string,
    context?: Record<string, unknown>,
  ): Promise<ResolvedEntity[]>;
}

/**
 * CreditAttribution contract — optional attribution engine.
 * When not provided, weight updates are skipped.
 */
export interface CreditAttribution {
  attribute(
    ledger: TraversalLedger,
    outcomeSignal: number,
    traceId: string,
  ): Promise<AttributionResult[]>;
}

// ─── InferenceEngine ─────────────────────────────────────

export class InferenceEngine implements IInferenceEngine {
  constructor(
    private graph: KnowledgeGraph,
    private resolver: NodeResolutionService,
    private policy: SelectionPolicy,
    private resolutionPipeline?: EntityResolutionPipeline,
    private attribution?: CreditAttribution,
    private propagation?: WeightPropagation,
    private updater?: EdgeWeightUpdater,
  ) {}

  // ─── Phase 2 backward-compatible resolve() ─────────────

  async resolve(
    task: string,
    _context?: Record<string, unknown>,
  ): Promise<InferencePlan> {
    const plan: InferencePlan = {
      task,
      resolved_entities: [],
      selected_edge: null,
      skill: null,
      confidence: 0,
      reasoning: '',
    };

    // Step 1: Extract and resolve entity mentions from the task
    const mentions = this.extractMentions(task);
    for (const mention of mentions) {
      try {
        const result = await this.resolver.resolve(mention);
        plan.resolved_entities.push({
          mention,
          node_id: result.node_id,
          confidence: result.confidence,
          match_type: result.match_type,
        });
      } catch {
        // Resolution failure is non-fatal
      }
    }

    // Step 2: Find candidate edges from resolved entities
    const candidateEdges: GraphEdge[] = [];
    for (const entity of plan.resolved_entities) {
      const edges = this.graph.getEdgesFrom(entity.node_id);
      candidateEdges.push(...edges);
    }

    // If no entities resolved, try a structural query for context nodes
    if (candidateEdges.length === 0) {
      const contextNodes = this.graph.queryStructural({
        node_type: NodeType.CONTEXT,
        limit: 10,
      });
      for (const result of contextNodes) {
        const edges = this.graph.getEdgesFrom(result.node.id);
        candidateEdges.push(...edges);
      }
    }

    // Step 3: Select best edge via SelectionPolicy
    if (candidateEdges.length > 0) {
      const unique = new Map(candidateEdges.map((e) => [e.id, e]));
      const selection = this.policy.select([...unique.values()]);

      if (selection) {
        const fromNode = this.graph.getNode(selection.edge.from_node);
        const toNode = this.graph.getNode(selection.edge.to_node);

        plan.selected_edge = {
          edge_id: selection.edge.id,
          from_label: fromNode?.label ?? selection.edge.from_node,
          to_label: toNode?.label ?? selection.edge.to_node,
          weight: selection.edge.weight,
          mode: selection.mode,
        };

        plan.confidence = selection.score;

        if (toNode?.metadata?.is_skill) {
          plan.skill = toNode.label;
        }

        plan.reasoning = `Selected ${plan.selected_edge.from_label} → ${plan.selected_edge.to_label} (weight: ${selection.edge.weight.toFixed(2)}, mode: ${selection.mode})`;
      }
    }

    if (!plan.selected_edge) {
      plan.reasoning = 'No candidate edges found — bootstrap mode may be needed';
    }

    return plan;
  }

  // ─── Phase 4 full inference pipeline ────────────────────

  async infer(req: InferenceRequest): Promise<InferenceResult> {
    const trace_id = crypto.randomUUID();
    const started = Date.now();

    // Step 1: Entity Resolution
    let resolvedEntities: ResolvedEntity[];
    if (this.resolutionPipeline) {
      resolvedEntities = await this.resolutionPipeline.extractAndResolve(
        req.input,
        req.context,
      );
    } else {
      resolvedEntities = await this.resolveEntitiesFallback(req.input);
    }

    // Step 2: Graph query — gather candidate edges from resolved entities
    const candidateEdges: GraphEdge[] = [];
    for (const entity of resolvedEntities) {
      const edges = this.graph.getEdgesFrom(entity.node_id);
      candidateEdges.push(...edges);
    }

    // Fallback to context nodes if nothing resolved
    if (candidateEdges.length === 0) {
      const contextNodes = this.graph.queryStructural({
        node_type: NodeType.CONTEXT,
        limit: 10,
      });
      for (const result of contextNodes) {
        const edges = this.graph.getEdgesFrom(result.node.id);
        candidateEdges.push(...edges);
      }
    }

    // Step 3: Plan selection via SelectionPolicy (epsilon-greedy)
    const unique = new Map(candidateEdges.map((e) => [e.id, e]));
    const deduped = [...unique.values()];
    const selection = deduped.length > 0 ? this.policy.select(deduped) : null;

    const planSelected: string[] = [];
    let skillName: string | null = null;

    // Step 4: Record in TraversalLedger (if available at runtime)
    if (selection) {
      planSelected.push(selection.edge.id);

      const toNode = this.graph.getNode(selection.edge.to_node);
      if (toNode?.metadata?.is_skill) {
        skillName = toNode.label;
      }

      // Record traversal in a ledger instance if one is passed through context
      const ledger = req.context?.['_traversal_ledger'] as TraversalLedger | undefined;
      if (ledger) {
        const siblings = this.graph.getEdgesFrom(selection.edge.from_node);
        ledger.record(selection.edge, 0, siblings);
      }
    }

    // Step 5: Build output description (no subagent delegation in core)
    let output: string;
    if (selection) {
      const fromNode = this.graph.getNode(selection.edge.from_node);
      const toNode = this.graph.getNode(selection.edge.to_node);
      const fromLabel = fromNode?.label ?? selection.edge.from_node;
      const toLabel = toNode?.label ?? selection.edge.to_node;
      output = skillName
        ? `Skill: ${skillName} (via ${fromLabel} → ${toLabel}, weight: ${selection.edge.weight.toFixed(2)}, mode: ${selection.mode})`
        : `Plan: ${fromLabel} → ${toLabel} (weight: ${selection.edge.weight.toFixed(2)}, mode: ${selection.mode})`;
    } else {
      output = 'No plan selected — bootstrap mode may be needed';
    }

    // Step 6: If outcome available, run attribution + weight update
    const outcomeSignal = req.context?.['outcome_signal'] as number | undefined;
    if (
      outcomeSignal !== undefined &&
      this.attribution &&
      this.propagation
    ) {
      const ledger = req.context?.['_traversal_ledger'] as TraversalLedger | undefined;
      if (ledger) {
        await this.attribution.attribute(ledger, outcomeSignal, trace_id);

        const outcome: OutcomeSignal = {
          value: outcomeSignal,
          type: 'explicit',
          trace_id,
          resolved_at: Date.now(),
        };
        await this.propagation.propagate(ledger.toStepLedgers(), outcome);
      }
    }

    // Step 7: Decorate with skill metadata if present in context
    const contextSkillName = req.context?.['skill_name'] as string | undefined;
    const deferred = req.context?.['deferred'] === true;

    const result: InferenceResult = {
      output,
      trace_id,
      entities_resolved: resolvedEntities.map((e) => e.node_id),
      plan_selected: planSelected,
      subagent_result: req.context?.['subagent_result'],
      outcome_signal: outcomeSignal,
      deferred,
    };

    return result;
  }

  // ─── Private helpers ────────────────────────────────────

  /**
   * Fallback entity resolution using the simple NodeResolutionService.
   * Used when no EntityResolutionPipeline is provided.
   */
  private async resolveEntitiesFallback(input: string): Promise<ResolvedEntity[]> {
    const mentions = this.extractMentions(input);
    const resolved: ResolvedEntity[] = [];

    for (const mention of mentions) {
      try {
        const result = await this.resolver.resolve(mention);
        resolved.push({
          mention,
          node_id: result.node_id,
          confidence: result.confidence,
          match_type: result.match_type,
        });
      } catch {
        // Resolution failure is non-fatal
      }
    }

    return resolved;
  }

  /**
   * Simple mention extraction: split task into potential entity names.
   * Phase 4 EntityResolutionPipeline provides LLM-based NER as upgrade.
   */
  private extractMentions(task: string): string[] {
    const mentions: string[] = [];
    const words = task.split(/\s+/).filter(Boolean);

    // Try pairs first (e.g., "Acme Corp")
    for (let i = 0; i < words.length - 1; i++) {
      const pair = `${words[i]} ${words[i + 1]}`;
      if (/^[A-Z]/.test(words[i]) && /^[A-Z]/.test(words[i + 1])) {
        mentions.push(pair);
      }
    }

    // Then individual capitalized words
    for (const word of words) {
      if (/^[A-Z]/.test(word) && word.length > 2) {
        mentions.push(word);
      }
    }

    return [...new Set(mentions)];
  }
}
