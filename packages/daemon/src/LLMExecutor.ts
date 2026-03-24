/**
 * LLMExecutor — real LLM API calls with tool use + token streaming.
 * Supports Anthropic, OpenAI, xAI, Gemini, Ollama.
 */

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
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

export interface LLMResponse {
  content: string;
  tool_calls: ToolCall[] | null;
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop';
  tokens_used: number;
  model: string;
}

export interface LLMConfig {
  provider: string;
  model: string;
  api_key: string;
  base_url?: string;
}

// Tool definitions available to the agent
export const AGENT_TOOLS: ToolDefinition[] = [
  {
    name: 'shell_exec',
    description: 'Execute a shell command in the working directory. Use for running servers (with & for background), installing packages, running tests, git operations, etc. Returns stdout + stderr.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        timeout_ms: { type: 'number', description: 'Timeout in milliseconds (default 30000)' },
      },
      required: ['command'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file. Creates parent directories if needed. Use for creating HTML, CSS, JS, config files, etc.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to working directory' },
        content: { type: 'string', description: 'Full file content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a file\'s contents.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to working directory' },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_dir',
    description: 'List files and directories.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path relative to working directory (default: ".")' },
      },
    },
  },
];

export class LLMExecutor {
  constructor(private config: LLMConfig) {}

  get isConfigured(): boolean {
    if (this.config.provider === 'ollama') return true;
    return !!(this.config.api_key?.trim());
  }

  // ─── Single completion (no tools, no streaming) ──────────────────────────

  async complete(messages: LLMMessage[], system?: string): Promise<{ content: string; tokens_used: number; model: string }> {
    const res = await this.completeWithTools(messages, [], system, undefined);
    return { content: res.content, tokens_used: res.tokens_used, model: res.model };
  }

  // ─── Tool-calling completion with optional streaming ─────────────────────

  async completeWithTools(
    messages: LLMMessage[],
    tools: ToolDefinition[],
    system?: string,
    onToken?: (token: string) => void,
  ): Promise<LLMResponse> {
    switch (this.config.provider) {
      case 'anthropic': return this.anthropic(messages, tools, system, onToken);
      case 'openai':    return this.openai(messages, tools, system, onToken);
      case 'xai':       return this.openai(messages, tools, system, onToken, 'https://api.x.ai/v1');
      case 'gemini':    return this.openai(messages, tools, system, onToken, 'https://generativelanguage.googleapis.com/v1beta/openai');
      case 'ollama':    return this.ollama(messages, system, onToken);
      default:          return this.openai(messages, tools, system, onToken);
    }
  }

  // ─── Anthropic ───────────────────────────────────────────────────────────

  private async anthropic(
    messages: LLMMessage[],
    tools: ToolDefinition[],
    system?: string,
    onToken?: (token: string) => void,
  ): Promise<LLMResponse> {
    const sysContent = system ?? messages.find(m => m.role === 'system')?.content;
    const filtered = messages.filter(m => m.role !== 'system');

    // Convert messages to Anthropic format (handles tool results)
    const anthropicMsgs = filtered.map(m => {
      if (m.role === 'tool') {
        return {
          role: 'user' as const,
          content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content }],
        };
      }
      if (m.role === 'assistant' && m.tool_calls?.length) {
        return {
          role: 'assistant' as const,
          content: [
            ...(m.content ? [{ type: 'text', text: m.content }] : []),
            ...m.tool_calls.map(tc => ({
              type: 'tool_use',
              id: tc.id,
              name: tc.name,
              input: tc.input,
            })),
          ],
        };
      }
      return { role: m.role as 'user' | 'assistant', content: m.content };
    });

    const body: Record<string, unknown> = {
      model: this.config.model,
      max_tokens: 8192,
      messages: anthropicMsgs,
      stream: true,
    };
    if (sysContent) body.system = sysContent;
    if (tools.length > 0) {
      body.tools = tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      }));
    }

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.config.api_key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Anthropic ${res.status}: ${err}`);
    }

    // Parse SSE stream
    let textContent = '';
    let stopReason: LLMResponse['stop_reason'] = 'end_turn';
    let inputTokens = 0;
    let outputTokens = 0;
    let modelName = this.config.model;
    const toolCalls: ToolCall[] = [];
    const toolInputBuffers: Record<string, string> = {};
    let currentToolId = '';

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      const lines = buf.split('\n');
      buf = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]' || data === '') continue;

        let evt: Record<string, unknown>;
        try { evt = JSON.parse(data); } catch { continue; }

        const type = evt.type as string;

        if (type === 'message_start') {
          const usage = (evt.message as Record<string, unknown>)?.usage as Record<string, unknown> | undefined;
          inputTokens = (usage?.input_tokens as number) ?? 0;
          modelName = ((evt.message as Record<string, unknown>)?.model as string) ?? modelName;
        } else if (type === 'content_block_start') {
          const block = evt.content_block as Record<string, unknown>;
          if (block?.type === 'tool_use') {
            currentToolId = block.id as string;
            toolInputBuffers[currentToolId] = '';
            toolCalls.push({ id: currentToolId, name: block.name as string, input: {} });
          }
        } else if (type === 'content_block_delta') {
          const delta = evt.delta as Record<string, unknown>;
          if (delta?.type === 'text_delta') {
            const token = delta.text as string ?? '';
            textContent += token;
            if (onToken && token) onToken(token);
          } else if (delta?.type === 'input_json_delta') {
            toolInputBuffers[currentToolId] = (toolInputBuffers[currentToolId] ?? '') + (delta.partial_json as string ?? '');
          }
        } else if (type === 'content_block_stop') {
          // Finalize tool input if present
          if (currentToolId && toolInputBuffers[currentToolId]) {
            const tc = toolCalls.find(t => t.id === currentToolId);
            if (tc) {
              try { tc.input = JSON.parse(toolInputBuffers[currentToolId]); } catch {}
            }
          }
        } else if (type === 'message_delta') {
          const usage = (evt.usage as Record<string, unknown>);
          outputTokens = (usage?.output_tokens as number) ?? 0;
          const stop = (evt.delta as Record<string, unknown>)?.stop_reason as string;
          if (stop === 'tool_use') stopReason = 'tool_use';
          else if (stop === 'end_turn') stopReason = 'end_turn';
          else if (stop === 'max_tokens') stopReason = 'max_tokens';
        }
      }
    }

    return {
      content: textContent,
      tool_calls: toolCalls.length > 0 ? toolCalls : null,
      stop_reason: stopReason,
      tokens_used: inputTokens + outputTokens,
      model: modelName,
    };
  }

  // ─── OpenAI (also xAI, Gemini) ───────────────────────────────────────────

  private async openai(
    messages: LLMMessage[],
    tools: ToolDefinition[],
    system?: string,
    onToken?: (token: string) => void,
    baseUrl = 'https://api.openai.com/v1',
  ): Promise<LLMResponse> {
    const allMessages: Record<string, unknown>[] = [];
    const sysContent = system ?? messages.find(m => m.role === 'system')?.content;
    if (sysContent) allMessages.push({ role: 'system', content: sysContent });

    for (const m of messages.filter(m => m.role !== 'system')) {
      if (m.role === 'tool') {
        allMessages.push({ role: 'tool', tool_call_id: m.tool_call_id, content: m.content });
      } else if (m.role === 'assistant' && m.tool_calls?.length) {
        allMessages.push({
          role: 'assistant',
          content: m.content || null,
          tool_calls: m.tool_calls.map(tc => ({
            id: tc.id, type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.input) },
          })),
        });
      } else {
        allMessages.push({ role: m.role, content: m.content });
      }
    }

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: allMessages,
      max_tokens: 8192,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (tools.length > 0) {
      body.tools = tools.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.input_schema },
      }));
    }

    const res = await fetch(`${this.config.base_url ?? baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.api_key}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OpenAI ${res.status}: ${err}`);
    }

    let textContent = '';
    let tokensUsed = 0;
    let modelName = this.config.model;
    let stopReason: LLMResponse['stop_reason'] = 'end_turn';
    const toolCallMap: Record<number, { id: string; name: string; args: string }> = {};

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;

        let evt: Record<string, unknown>;
        try { evt = JSON.parse(data); } catch { continue; }

        modelName = (evt.model as string) ?? modelName;
        const usage = evt.usage as Record<string, unknown> | undefined;
        if (usage?.total_tokens) tokensUsed = usage.total_tokens as number;

        const choices = evt.choices as Array<Record<string, unknown>> | undefined;
        if (!choices?.length) continue;
        const delta = choices[0].delta as Record<string, unknown> | undefined;
        if (!delta) continue;

        const finish = choices[0].finish_reason as string;
        if (finish === 'tool_calls') stopReason = 'tool_use';
        else if (finish === 'stop') stopReason = 'end_turn';

        const token = delta.content as string | undefined;
        if (token) { textContent += token; if (onToken) onToken(token); }

        const toolCallDeltas = delta.tool_calls as Array<Record<string, unknown>> | undefined;
        if (toolCallDeltas) {
          for (const tc of toolCallDeltas) {
            const idx = tc.index as number;
            if (!toolCallMap[idx]) {
              toolCallMap[idx] = { id: '', name: '', args: '' };
            }
            const fn = tc.function as Record<string, unknown> | undefined;
            if (tc.id) toolCallMap[idx].id = tc.id as string;
            if (fn?.name) toolCallMap[idx].name = fn.name as string;
            if (fn?.arguments) toolCallMap[idx].args += fn.arguments as string;
          }
        }
      }
    }

    const toolCalls = Object.values(toolCallMap)
      .filter(tc => tc.id && tc.name)
      .map(tc => {
        let input: Record<string, unknown> = {};
        try { input = JSON.parse(tc.args); } catch {}
        return { id: tc.id, name: tc.name, input };
      });

    return {
      content: textContent,
      tool_calls: toolCalls.length > 0 ? toolCalls : null,
      stop_reason: stopReason,
      tokens_used: tokensUsed,
      model: modelName,
    };
  }

  // ─── Ollama (no streaming for simplicity) ────────────────────────────────

  private async ollama(messages: LLMMessage[], system?: string, onToken?: (token: string) => void): Promise<LLMResponse> {
    const baseUrl = this.config.base_url ?? 'http://localhost:11434';
    const allMessages = [];
    const sysContent = system ?? messages.find(m => m.role === 'system')?.content;
    if (sysContent) allMessages.push({ role: 'system', content: sysContent });
    allMessages.push(...messages.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: m.content })));

    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.config.model, messages: allMessages, stream: false }),
    });

    if (!res.ok) throw new Error(`Ollama error ${res.status}`);
    const data = await res.json() as { message: { content: string }; eval_count?: number };
    if (onToken) onToken(data.message.content);
    return { content: data.message.content, tool_calls: null, stop_reason: 'end_turn', tokens_used: data.eval_count ?? 0, model: this.config.model };
  }
}
