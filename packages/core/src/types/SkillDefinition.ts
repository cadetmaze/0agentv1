/**
 * Skill Definition — the TypeScript interface for a parsed skill YAML file.
 *
 * Skills are configuration, not code. Each YAML file in ~/.0agent/skills/
 * or the built-in skills/ directory defines:
 * - A role prompt (system prompt for the subagent)
 * - A subagent profile (maps to CapabilityToken)
 * - Workflow position (where in the sprint chain)
 * - Outcome definition (how to measure success, feeds learning engine)
 */

export interface SkillDefinition {
  name: string;
  description: string;
  trigger: string; // e.g., "/review"
  category: SkillCategory;

  args: SkillArg[];

  subagent: SkillSubagentProfile;

  workflow: SkillWorkflow;

  output: SkillOutput;

  outcome: SkillOutcome;

  role_prompt: string;
}

export type SkillCategory =
  | "think"
  | "plan"
  | "build"
  | "review"
  | "test"
  | "ship"
  | "reflect"
  | "utility";

export interface SkillArg {
  name: string;
  description: string;
  required: boolean;
  default: string | null;
}

export interface SkillSubagentProfile {
  trust_level: 1 | 2;
  tools: string[];
  graph_scope: SkillGraphScope;
  sandbox: SkillSandboxConfig;
  duration_ms: number;
  model_override: string | null;
}

export interface SkillGraphScope {
  mode: "none" | "entities" | "context" | "full_readonly";
  entity_ids: string[]; // supports $CURRENT_PROJECT, $MENTIONED_ENTITIES
}

export interface SkillSandboxConfig {
  type: "process" | "docker" | "firecracker" | "auto";
  network_access: "none" | "allowlist" | "full";
  network_allowlist?: string[]; // supports $ARG_URL etc.
  filesystem_access: "none" | "readonly" | "scoped";
  filesystem_scope?: string; // supports $PROJECT_DIR
  has_browser: boolean;
}

export interface SkillWorkflow {
  follows: string[]; // skill names that typically precede this one
  feeds_into: string[]; // skill names that typically follow this one
}

export interface SkillOutput {
  format: "prose" | "json" | "markdown" | "diff";
  artifacts: string[];
  saves_to: string | null;
}

export type SkillVerifier =
  | "automatic"
  | "rule_based"
  | "llm_judge"
  | "human"
  | "deferred"
  | "learning_signal";

export interface SkillOutcome {
  verifier: SkillVerifier;
  success_criteria: string;
  failure_criteria: string;
  signal_source?: string; // field in output JSON that contains the signal
  deferred_ttl_hours?: number; // for deferred outcomes
  resolves?: string; // for learning_signal type (e.g., "current_sprint_traces")
}
