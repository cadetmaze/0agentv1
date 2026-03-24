/**
 * Self-Improvement Engine Types
 *
 * The self-improvement engine is a meta-capability that the main agent (Level 0)
 * executes directly — never delegated to a subagent. It runs at the end of every
 * /retro and on a configurable schedule (default: weekly).
 *
 * It analyzes the agent's own graph, traces, skills, and tools, then proposes
 * concrete improvements as a structured JSON plan. Safe actions auto-apply.
 * Risky actions require user approval.
 */

// ─── Configuration ──────────────────────────────────

export interface SelfImprovementConfig {
  enabled: boolean;
  schedule: "weekly" | "daily" | "after_every_retro" | "manual";
  auto_apply: AutoApplyPolicy;
}

export interface AutoApplyPolicy {
  graph_health: boolean; // auto-merge duplicates, archive dead zones, prune orphans
  workflow_edges: boolean; // propose only — user approves
  skill_prompts: boolean; // propose only — user approves
  tool_install: boolean; // propose only — user approves
  new_skills: boolean; // propose only — user approves
}

export const DEFAULT_SELF_IMPROVEMENT_CONFIG: SelfImprovementConfig = {
  enabled: true,
  schedule: "weekly",
  auto_apply: {
    graph_health: true,
    workflow_edges: false,
    skill_prompts: false,
    tool_install: false,
    new_skills: false,
  },
};

// ─── Analysis 1: Skill Gap Detection ────────────────

export interface SkillGap {
  context: string;
  solution_type: "new_skill" | "seed_graph" | "mcp_tool" | "entity_observation";
  proposed_skill?: {
    name: string;
    description: string;
    tools: string[];
    role_prompt_summary: string;
  };
  proposed_graph_change?: {
    nodes: Array<{ label: string; type: string }>;
    edges: Array<{ from: string; to: string; weight: number }>;
  };
  proposed_mcp?: {
    server_name: string;
    reason: string;
  };
  trace_ids: string[];
}

// ─── Analysis 2: Workflow Optimization ──────────────

export type WorkflowChangeType =
  | "add_edge"
  | "remove_edge"
  | "strengthen_recommendation"
  | "weaken_recommendation";

export interface WorkflowChange {
  type: WorkflowChangeType;
  from?: string;
  to?: string;
  edge?: string; // "from → to" for existing edges
  current_weight?: number;
  proposed_weight?: number;
  reason: string;
  supporting_trace_count: number;
}

// ─── Analysis 3: Graph Health ───────────────────────

export interface ContradictionCluster {
  edge_id: string;
  edge_label: string; // "from → to"
  positive_traces: number;
  negative_traces: number;
  traverse_count: number;
  diagnosis: string;
  proposed_fix: string;
}

export interface DeadZone {
  subgraph_id: string;
  root_entity: string;
  node_count: number;
  last_access_days_ago: number;
  recommend: "archive" | "keep" | "review";
  reason: string;
}

export interface DuplicateCluster {
  node_ids: string[];
  labels: string[];
  similarity: number;
  canonical_label: string;
  recommend_merge: boolean;
}

export interface OrphanNode {
  node_id: string;
  label: string;
  type: string;
  created_days_ago: number;
  recommend: "connect" | "prune";
  reason: string;
}

export interface GraphHealth {
  contradictions: ContradictionCluster[];
  dead_zones: DeadZone[];
  duplicates: DuplicateCluster[];
  orphans: OrphanNode[];
}

// ─── Analysis 4: Tool Utilization ───────────────────

export interface HighUseToolReport {
  tool: string;
  uses: number;
  avg_outcome: number;
}

export interface UnusedToolReport {
  tool: string;
  days_unused: number;
  recommend: "disconnect" | "keep" | "review";
}

export interface BrowserToApiSuggestion {
  domain: string;
  browser_visits: number;
  recommended_mcp: string;
}

export interface AuthFailure {
  tool: string;
  failure_count: number;
  last_failure_at: number;
  error_type: string;
}

export interface ToolUtilization {
  high_use: HighUseToolReport[];
  unused: UnusedToolReport[];
  browser_to_api: BrowserToApiSuggestion[];
  auth_failures: AuthFailure[];
}

// ─── Analysis 5: Skill Prompt Refinement ────────────

export interface SkillPromptEdit {
  section: string;
  current: string;
  proposed: string;
  reason: string;
}

export interface SkillRefinement {
  skill: string;
  success_rate: number;
  total_invocations: number;
  failure_pattern: string;
  proposed_edit: SkillPromptEdit;
}

// ─── Combined Improvement Plan ──────────────────────

export interface ImprovementPlan {
  generated_at: string; // ISO 8601
  evaluation_period: string; // "2026-03-17 to 2026-03-24"
  traces_analyzed: number;

  skill_gaps: SkillGap[];
  workflow_changes: WorkflowChange[];
  graph_health: GraphHealth;
  tool_utilization: ToolUtilization;
  skill_refinements: SkillRefinement[];

  priority_actions: PriorityAction[];
}

export interface PriorityAction {
  rank: number;
  description: string;
  category:
    | "graph_health"
    | "workflow"
    | "skill_prompt"
    | "tool"
    | "new_skill";
  auto_approvable: boolean; // based on AutoApplyPolicy
  estimated_impact: "high" | "medium" | "low";
}

// ─── Improvement History ────────────────────────────

export interface ImprovementRecord {
  plan_id: string;
  generated_at: string;
  actions_proposed: number;
  actions_applied: number;
  actions_rejected: number;
  actions_pending: number;
  applied_actions: AppliedAction[];
}

export interface AppliedAction {
  action_rank: number;
  description: string;
  applied_at: string;
  applied_by: "auto" | "user";
  result: "success" | "reverted" | "failed";
}
