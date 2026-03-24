import { z } from "zod";

export const LLMProviderSchema = z.object({
  provider: z.enum([
    "anthropic",
    "openai",
    "ollama",
    "groq",
    "gemini",
    "xai",
    "custom",
  ]),
  model: z.string(),
  api_key: z.string().optional(),
  base_url: z.string().optional(),
  is_default: z.boolean().default(false),
});

export const EmbeddingConfigSchema = z.object({
  provider: z.enum(["nomic-ollama", "openai", "ollama"]).default("nomic-ollama"),
  model: z.string().default("nomic-embed-text"),
  dimensions: z.number().default(768),
  ollama_base_url: z.string().default("http://localhost:11434"),
  openai_api_key: z.string().optional(),
});

export const SandboxConfigSchema = z.object({
  backend: z
    .enum(["auto", "firecracker", "docker", "podman", "bwrap", "cloud", "process"])
    .default("auto"),
  e2b_api_key: z.string().optional(),
  memory_mb: z.number().default(512),
  cpus: z.number().default(1),
});

export const MCPServerEntrySchema = z.object({
  name: z.string(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
  env: z.record(z.string()).optional(),
  enabled: z.boolean().default(true),
});

export const ServerConfigSchema = z.object({
  port: z.number().default(4200),
  host: z.string().default("127.0.0.1"),
  bearer_token: z.string().optional(),
});

export const GraphConfigSchema = z.object({
  db_path: z.string(),
  hnsw_path: z.string(),
  object_store_path: z.string(),
});

export const LearningConfigSchema = z.object({
  base_learning_rate: z.number().default(0.1),
  cross_graph_attenuation: z.number().default(0.3),
  base_step_discount: z.number().default(0.85),
  epsilon: z.number().default(0.15),
  temperature: z.number().default(0.5),
});

export const DecayConfigSchema = z.object({
  interval_hours: z.number().default(6),
  max_deferral_hours: z.number().default(24),
  grace_period_hours: z.number().default(48),
  max_per_cycle: z.number().default(0.05),
});

export const SelfImprovementConfigSchema = z.object({
  enabled: z.boolean().default(true),
  schedule: z.enum(["weekly", "daily", "after_every_retro", "manual"]).default("weekly"),
  auto_apply: z
    .object({
      graph_health: z.boolean().default(true),
      workflow_edges: z.boolean().default(false),
      skill_prompts: z.boolean().default(false),
      tool_install: z.boolean().default(false),
      new_skills: z.boolean().default(false),
    })
    .default({}),
});

export const EntityVisibilityPolicySchema = z.object({
  allow_work_context: z.boolean().default(true),
  allow_signal_nodes: z.boolean().default(true),
  allow_personality_profile: z.boolean().default(false),
  allow_raw_conversations: z.boolean().default(false),
});

export const EntityNestingConfigSchema = z.object({
  enabled: z.boolean().default(true),
  // When a session has entity_id, accumulate personality after completion
  accumulate_personality: z.boolean().default(true),
  // Minimum interactions before personality influences responses
  personality_min_interactions: z.number().default(3),
  // How much to attenuate signals propagating to parent entities (0-1)
  parent_propagation_attenuation: z.number().default(0.5),
  // Visibility policy — what parent entities see from children
  visibility_policy: EntityVisibilityPolicySchema.default({}),
});

export const DaemonConfigSchema = z.object({
  version: z.string().default("1"),
  llm_providers: z.array(LLMProviderSchema).min(1),
  embedding: EmbeddingConfigSchema.default({}),
  sandbox: SandboxConfigSchema.default({}),
  mcp_servers: z.array(MCPServerEntrySchema).default([]),
  server: ServerConfigSchema.default({}),
  graph: GraphConfigSchema,
  learning: LearningConfigSchema.default({}),
  decay: DecayConfigSchema.default({}),
  seed: z.string().optional(),
  self_improvement: SelfImprovementConfigSchema.default({}),
  entity_nesting: EntityNestingConfigSchema.default({}),
  github_memory: z.object({
    enabled: z.boolean().default(false),
    token:   z.string().default(''),
    owner:   z.string().default(''),
    repo:    z.string().default('0agent-memory'),
  }).default({}),
});

export type DaemonConfig = z.infer<typeof DaemonConfigSchema>;
export type LLMProvider = z.infer<typeof LLMProviderSchema>;
export type EmbeddingConfig = z.infer<typeof EmbeddingConfigSchema>;
export type SandboxConfig = z.infer<typeof SandboxConfigSchema>;
export type MCPServerEntry = z.infer<typeof MCPServerEntrySchema>;
export type EntityVisibilityPolicy = z.infer<typeof EntityVisibilityPolicySchema>;
export type EntityNestingConfig = z.infer<typeof EntityNestingConfigSchema>;
