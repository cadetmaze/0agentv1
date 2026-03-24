/**
 * Self-Improvement Engine
 *
 * Runs the 5 analyses (skill gaps, workflow optimization, graph health,
 * tool utilization, skill prompt refinement) against the live graph and
 * trace store, producing an ImprovementPlan.
 *
 * This is executed by the main agent (Level 0) directly — never delegated
 * to a subagent. It has full read access to the graph and trace store.
 *
 * The engine itself does NOT apply changes. It produces a plan. The daemon's
 * SelfImprovementApplicator reads the plan + auto_apply config and decides
 * what to apply automatically vs. what to queue for user approval.
 */

import type { KnowledgeGraph } from "../graph/KnowledgeGraph.js";
import type { GraphEdge } from "../graph/GraphEdge.js";
import type { ILLMClient } from "../bootstrap/GraphConstructor.js";
import type {
  ImprovementPlan,
  SelfImprovementConfig,
  SkillGap,
  WorkflowChange,
  GraphHealth,
  ToolUtilization,
  SkillRefinement,
  PriorityAction,
  ContradictionCluster,
  DeadZone,
  DuplicateCluster,
  OrphanNode,
} from "../types/SelfImprovement.js";
import { SELF_IMPROVEMENT_PROMPT } from "./SelfImprovementPrompt.js";

export interface SelfImprovementContext {
  evaluation_period_start: number;
  evaluation_period_end: number;
  skill_definitions: Array<{ name: string; role_prompt: string }>;
  mcp_tools: Array<{ name: string; server: string }>;
}

export class SelfImprovementEngine {
  constructor(
    private graph: KnowledgeGraph,
    private llm: ILLMClient,
    private config: SelfImprovementConfig,
  ) {}

  /**
   * Run the full 5-analysis improvement cycle.
   *
   * In Phase 1-2, this runs the analyses as pure graph queries.
   * In Phase 4+, this uses the LLM with SELF_IMPROVEMENT_PROMPT to
   * generate more nuanced recommendations.
   */
  async analyze(ctx: SelfImprovementContext): Promise<ImprovementPlan> {
    const [skillGaps, workflowChanges, graphHealth, toolUtil, skillRefinements] =
      await Promise.all([
        this.analyzeSkillGaps(ctx),
        this.analyzeWorkflow(ctx),
        this.analyzeGraphHealth(ctx),
        this.analyzeToolUtilization(ctx),
        this.analyzeSkillPrompts(ctx),
      ]);

    const priorityActions = this.rankActions(
      skillGaps,
      workflowChanges,
      graphHealth,
      toolUtil,
      skillRefinements,
    );

    return {
      generated_at: new Date().toISOString(),
      evaluation_period: `${new Date(ctx.evaluation_period_start).toISOString().slice(0, 10)} to ${new Date(ctx.evaluation_period_end).toISOString().slice(0, 10)}`,
      traces_analyzed: 0, // TODO: count traces in period
      skill_gaps: skillGaps,
      workflow_changes: workflowChanges,
      graph_health: graphHealth,
      tool_utilization: toolUtil,
      skill_refinements: skillRefinements,
      priority_actions: priorityActions,
    };
  }

  // ─── Analysis 1: Skill Gap Detection ────────────────

  private async analyzeSkillGaps(
    _ctx: SelfImprovementContext,
  ): Promise<SkillGap[]> {
    // Scan traces where bootstrap mode was triggered or resolution confidence < 0.65
    // For Phase 1: return empty (no traces yet)
    // For Phase 4+: use LLM to analyze trace patterns
    return [];
  }

  // ─── Analysis 2: Workflow Optimization ──────────────

  private async analyzeWorkflow(
    _ctx: SelfImprovementContext,
  ): Promise<WorkflowChange[]> {
    const changes: WorkflowChange[] = [];
    const edges = this.graph.getAllEdges();

    for (const edge of edges) {
      // Edges that decayed below 0.3 → recommend removal
      if (edge.weight < 0.3 && edge.traversal_count > 5) {
        changes.push({
          type: "remove_edge",
          edge: `${edge.from_node} → ${edge.to_node}`,
          current_weight: edge.weight,
          reason: `Weight ${edge.weight.toFixed(2)} after ${edge.traversal_count} traversals — consistently negative outcomes`,
          supporting_trace_count: edge.traversal_count,
        });
      }

      // Edges that grew above 0.85 → recommend as default
      if (edge.weight > 0.85 && edge.traversal_count > 5) {
        changes.push({
          type: "strengthen_recommendation",
          edge: `${edge.from_node} → ${edge.to_node}`,
          current_weight: edge.weight,
          reason: `Weight ${edge.weight.toFixed(2)} after ${edge.traversal_count} traversals — consistently positive outcomes`,
          supporting_trace_count: edge.traversal_count,
        });
      }
    }

    return changes;
  }

  // ─── Analysis 3: Graph Health ─────────────────────

  private async analyzeGraphHealth(
    _ctx: SelfImprovementContext,
  ): Promise<GraphHealth> {
    return {
      contradictions: this.findContradictions(),
      dead_zones: this.findDeadZones(),
      duplicates: [], // Requires embedding comparison — Phase 4+
      orphans: this.findOrphans(),
    };
  }

  private findContradictions(): ContradictionCluster[] {
    const clusters: ContradictionCluster[] = [];
    const edges = this.graph.getAllEdges();

    for (const edge of edges) {
      // High traverse count but weight near 0.5 → contradiction
      if (
        edge.traversal_count > 10 &&
        Math.abs(edge.weight - 0.5) < 0.1
      ) {
        const fromNode = this.graph.getNode(edge.from_node);
        const toNode = this.graph.getNode(edge.to_node);
        if (!fromNode || !toNode) continue;

        clusters.push({
          edge_id: edge.id,
          edge_label: `${fromNode.label} → ${toNode.label}`,
          positive_traces: Math.floor(edge.traversal_count * 0.5), // approximate
          negative_traces: Math.floor(edge.traversal_count * 0.5),
          traverse_count: edge.traversal_count,
          diagnosis: `Weight oscillating near 0.5 despite ${edge.traversal_count} traversals — likely missing context`,
          proposed_fix: `Add disambiguating context node between "${fromNode.label}" and "${toNode.label}"`,
        });
      }
    }

    return clusters;
  }

  private findDeadZones(): DeadZone[] {
    const zones: DeadZone[] = [];
    const now = Date.now();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

    // Check all entity nodes for recent access
    const nodes = this.graph.queryStructural({ node_type: "entity" as any, limit: 1000 });
    for (const result of nodes) {
      const node = result.node;
      const daysSinceAccess = Math.floor((now - node.last_seen) / (24 * 60 * 60 * 1000));

      if (daysSinceAccess > 30) {
        const subgraph = this.graph.getSubGraph(node.id, 1);
        zones.push({
          subgraph_id: node.id,
          root_entity: node.label,
          node_count: subgraph.nodeCount,
          last_access_days_ago: daysSinceAccess,
          recommend: daysSinceAccess > 90 ? "archive" : "review",
          reason:
            daysSinceAccess > 90
              ? `No access in ${daysSinceAccess} days — safe to archive`
              : `No access in ${daysSinceAccess} days — review before archiving`,
        });
      }
    }

    return zones;
  }

  private findOrphans(): OrphanNode[] {
    const orphans: OrphanNode[] = [];
    const now = Date.now();

    // This is a simplified scan — full implementation would iterate all nodes
    // For now, check nodes with no outgoing or incoming edges
    const nodes = this.graph.queryStructural({ limit: 1000 });
    for (const result of nodes) {
      const node = result.node;
      const edges = this.graph.getEdgesByNode(node.id, "both");

      if (edges.length === 0) {
        const daysSinceCreation = Math.floor(
          (now - node.created_at) / (24 * 60 * 60 * 1000),
        );
        orphans.push({
          node_id: node.id,
          label: node.label,
          type: node.type,
          created_days_ago: daysSinceCreation,
          recommend: daysSinceCreation > 14 ? "prune" : "connect",
          reason:
            daysSinceCreation > 14
              ? `Orphan node with no edges for ${daysSinceCreation} days`
              : `Recently created orphan — may need connections`,
        });
      }
    }

    return orphans;
  }

  // ─── Analysis 4: Tool Utilization ─────────────────

  private async analyzeToolUtilization(
    _ctx: SelfImprovementContext,
  ): Promise<ToolUtilization> {
    // Requires MCP tool usage tracking — Phase 4+
    return {
      high_use: [],
      unused: [],
      browser_to_api: [],
      auth_failures: [],
    };
  }

  // ─── Analysis 5: Skill Prompt Refinement ──────────

  private async analyzeSkillPrompts(
    _ctx: SelfImprovementContext,
  ): Promise<SkillRefinement[]> {
    // Requires skill-level trace analysis — Phase 4+
    return [];
  }

  // ─── Priority Ranking ─────────────────────────────

  private rankActions(
    gaps: SkillGap[],
    workflow: WorkflowChange[],
    health: GraphHealth,
    _tools: ToolUtilization,
    refinements: SkillRefinement[],
  ): PriorityAction[] {
    const actions: PriorityAction[] = [];
    let rank = 1;

    // Graph health contradictions are highest priority
    for (const c of health.contradictions) {
      actions.push({
        rank: rank++,
        description: `Resolve contradiction: ${c.edge_label} (${c.traverse_count} traversals, weight ~0.5)`,
        category: "graph_health",
        auto_approvable: this.config.auto_apply.graph_health,
        estimated_impact: "high",
      });
    }

    // Skill refinements with low success rate
    for (const r of refinements) {
      if (r.success_rate < 0.5) {
        actions.push({
          rank: rank++,
          description: `Fix /${r.skill} prompt: ${r.failure_pattern}`,
          category: "skill_prompt",
          auto_approvable: this.config.auto_apply.skill_prompts,
          estimated_impact: "high",
        });
      }
    }

    // Skill gaps
    for (const g of gaps) {
      actions.push({
        rank: rank++,
        description: `${g.solution_type === "new_skill" ? "Create" : "Add"}: ${g.context}`,
        category: "new_skill",
        auto_approvable: this.config.auto_apply.new_skills,
        estimated_impact: "medium",
      });
    }

    // Workflow changes
    for (const w of workflow) {
      actions.push({
        rank: rank++,
        description: `${w.type}: ${w.reason}`,
        category: "workflow",
        auto_approvable: this.config.auto_apply.workflow_edges,
        estimated_impact: w.type === "remove_edge" ? "medium" : "low",
      });
    }

    // Dead zones and orphans
    for (const dz of health.dead_zones) {
      if (dz.recommend === "archive") {
        actions.push({
          rank: rank++,
          description: `Archive dead zone: ${dz.root_entity} (${dz.node_count} nodes, ${dz.last_access_days_ago} days inactive)`,
          category: "graph_health",
          auto_approvable: this.config.auto_apply.graph_health,
          estimated_impact: "low",
        });
      }
    }

    for (const o of health.orphans) {
      if (o.recommend === "prune") {
        actions.push({
          rank: rank++,
          description: `Prune orphan: ${o.label} (${o.type}, no edges)`,
          category: "graph_health",
          auto_approvable: this.config.auto_apply.graph_health,
          estimated_impact: "low",
        });
      }
    }

    return actions;
  }

  /**
   * Get the system prompt for LLM-powered analysis (Phase 4+).
   * The prompt is injected with actual graph/trace data as context.
   */
  getPrompt(): string {
    return SELF_IMPROVEMENT_PROMPT;
  }
}
