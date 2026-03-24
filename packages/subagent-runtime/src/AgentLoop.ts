import type { MCPProxy } from './MCPProxy.js';
import type { ResourceTracker, ToolCallRecord } from './ResourceTracker.js';

// ─── LLM Types ──────────────────────────────────────

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
}

export interface LLMResponse {
  content: string;
  finish_reason: 'stop' | 'tool_use';
  tool_calls?: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
  }>;
  tokens_used: number;
}

export interface ILLMClient {
  complete(messages: LLMMessage[]): Promise<LLMResponse>;
}

// ─── Result ─────────────────────────────────────────

export interface AgentLoopResult {
  output: string;
  exit_reason: 'completed' | 'resource_limit' | 'error';
  tool_calls: ToolCallRecord[];
  llm_calls_used: number;
  tokens_used: number;
}

// ─── AgentLoop ──────────────────────────────────────

/**
 * Simple LLM + tool execution loop.
 *
 * Each iteration:
 *  1. Check resource limits
 *  2. Call LLM with current message history
 *  3. If LLM returns tool_calls: execute each via MCPProxy, append results
 *  4. If LLM returns stop: break and return final output
 */
export class AgentLoop {
  constructor(
    private readonly systemPrompt: string,
    private readonly llm: ILLMClient,
    private readonly proxy: MCPProxy,
    private readonly tracker: ResourceTracker,
  ) {}

  async run(task: string): Promise<AgentLoopResult> {
    const messages: LLMMessage[] = [
      { role: 'system', content: this.systemPrompt },
      { role: 'user', content: task },
    ];

    let lastOutput = '';

    while (true) {
      // Check if we can still make LLM calls
      if (!this.tracker.canMakeLLMCall()) {
        return this.buildResult(lastOutput || 'Resource limit reached: max LLM calls exceeded', 'resource_limit');
      }

      // Call LLM
      let response: LLMResponse;
      try {
        response = await this.llm.complete(messages);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return this.buildResult(`LLM error: ${msg}`, 'error');
      }

      // Record usage
      this.tracker.recordLLMCall(response.tokens_used);
      lastOutput = response.content;

      // Append assistant message
      messages.push({ role: 'assistant', content: response.content });

      // If stop, we are done
      if (response.finish_reason === 'stop' || !response.tool_calls?.length) {
        return this.buildResult(response.content, 'completed');
      }

      // Execute tool calls
      for (const toolCall of response.tool_calls) {
        if (!this.tracker.canMakeToolCall()) {
          return this.buildResult(
            lastOutput || 'Resource limit reached: max tool calls exceeded',
            'resource_limit',
          );
        }

        const callStart = Date.now();
        let toolOutput: unknown;
        try {
          toolOutput = await this.proxy.call(toolCall.name, toolCall.input);
        } catch (err: unknown) {
          toolOutput = { error: err instanceof Error ? err.message : String(err) };
        }
        const callDuration = Date.now() - callStart;

        this.tracker.recordToolCall(
          toolCall.name,
          toolCall.input,
          toolOutput,
          callDuration,
        );

        // Append tool result message
        messages.push({
          role: 'tool',
          content: typeof toolOutput === 'string' ? toolOutput : JSON.stringify(toolOutput),
          tool_call_id: toolCall.id,
        });
      }
    }
  }

  private buildResult(
    output: string,
    exitReason: AgentLoopResult['exit_reason'],
  ): AgentLoopResult {
    return {
      output,
      exit_reason: exitReason,
      tool_calls: this.tracker.getToolCallRecords(),
      llm_calls_used: this.tracker.llm_calls,
      tokens_used: this.tracker.tokens_used,
    };
  }
}
