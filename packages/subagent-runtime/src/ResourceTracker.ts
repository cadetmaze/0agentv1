// ─── Types ──────────────────────────────────────────

export interface ToolCallRecord {
  tool_name: string;
  input: Record<string, unknown>;
  output_summary: string;
  duration_ms: number;
  timestamp: number;
}

// ─── ResourceTracker ────────────────────────────────

/**
 * Counts resource usage against token-imposed limits.
 *
 * The subagent runtime checks this tracker before every LLM call
 * and tool call to enforce the capability token's resource budget.
 */
export class ResourceTracker {
  llm_calls = 0;
  tokens_used = 0;
  tool_calls_count = 0;
  private tool_call_records: ToolCallRecord[] = [];

  constructor(
    private readonly maxLLMCalls: number,
    private readonly maxTokens: number,
    private readonly maxToolCalls: number,
  ) {}

  canMakeLLMCall(): boolean {
    return this.llm_calls < this.maxLLMCalls;
  }

  canMakeToolCall(): boolean {
    return this.tool_calls_count < this.maxToolCalls;
  }

  recordLLMCall(tokensUsed: number): void {
    this.llm_calls++;
    this.tokens_used += tokensUsed;
  }

  recordToolCall(
    name: string,
    input: Record<string, unknown>,
    output: unknown,
    durationMs: number,
  ): void {
    this.tool_calls_count++;
    this.tool_call_records.push({
      tool_name: name,
      input,
      output_summary: String(output).slice(0, 200),
      duration_ms: durationMs,
      timestamp: Date.now(),
    });
  }

  getToolCallRecords(): ToolCallRecord[] {
    return this.tool_call_records;
  }
}
