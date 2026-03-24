export interface SubagentArtifact {
  id: string;
  type: 'screenshot' | 'file' | 'text' | 'structured';
  content: string;
  mime_type: string;
  filename?: string;
  created_at: number;
}

export interface ToolCallRecord {
  tool_name: string;
  input: Record<string, unknown>;
  output_summary: string;
  duration_ms: number;
  timestamp: number;
}

export interface SubagentResult {
  subagent_id: string;
  session_id: string;
  task: string;
  output: string;
  artifacts: SubagentArtifact[];
  tool_calls: ToolCallRecord[];
  llm_calls_used: number;
  tokens_used: number;
  tool_calls_count: number;
  exit_reason: 'completed' | 'timeout' | 'resource_limit' | 'error' | 'killed';
  duration_ms: number;
  error?: string;
}

/**
 * Create a SubagentResult representing an error outcome.
 */
export function errorResult(
  subagentId: string,
  sessionId: string,
  task: string,
  err: unknown,
  startedAt: number,
): SubagentResult {
  const message =
    err instanceof Error ? err.message : String(err);

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
    exit_reason: 'error',
    duration_ms: Date.now() - startedAt,
    error: message,
  };
}
