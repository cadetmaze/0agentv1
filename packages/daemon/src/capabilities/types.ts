/**
 * Shared capability types.
 *
 * Each capability is a self-contained module that:
 * - Knows how to do one thing well
 * - Has its own retry/fallback chain
 * - Returns a structured CapabilityResult
 * - Can be tested independently
 *
 * The AgentExecutor is a pure adapter — it routes LLM tool calls
 * to the right capability and collects findings.
 */

export interface CapabilityResult {
  success: boolean;
  output: string;                     // always a human-readable string for LLM
  structured?: unknown;               // optional parsed data (arrays, objects)
  fallback_used?: string;             // e.g., "browser" if primary failed
  duration_ms: number;
  error?: string;
}

export interface Capability {
  readonly name: string;
  readonly description: string;
  readonly toolDefinition: ToolDefinition;
  execute(input: Record<string, unknown>, cwd: string, signal?: AbortSignal): Promise<CapabilityResult>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required?: string[];
  };
}
