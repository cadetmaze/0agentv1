import { AgentLoop } from './AgentLoop.js';
import type { ILLMClient } from './AgentLoop.js';
import { MCPProxy } from './MCPProxy.js';
import { OutputChannel } from './OutputChannel.js';
import { TokenValidator } from './TokenValidator.js';
import { ResourceTracker } from './ResourceTracker.js';

const INPUT_SENTINEL = '__PAYLOAD_END__';

// ─── Payload shape ──────────────────────────────────

interface Payload {
  token: Record<string, unknown>;
  task: string;
  system_prompt?: string;
  context?: Record<string, unknown>;
  graph_snapshot?: unknown;
  mcp_proxy_url?: string;
}

// ─── Stub LLM client (Phase 3) ─────────────────────

/**
 * Placeholder LLM client. In production this will be replaced by
 * the real Anthropic/OpenAI client injected via config.
 */
const stubLLM: ILLMClient = {
  async complete(messages) {
    const lastMessage = messages[messages.length - 1];
    return {
      content: `[stub] Processed: ${lastMessage?.content?.slice(0, 100) ?? ''}`,
      finish_reason: 'stop' as const,
      tokens_used: 0,
    };
  },
};

// ─── Read stdin until sentinel ──────────────────────

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    process.stdin.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      const combined = Buffer.concat(chunks).toString('utf-8');
      if (combined.includes(INPUT_SENTINEL)) {
        const payload = combined.split(INPUT_SENTINEL)[0]!.trim();
        resolve(payload);
      }
    });

    process.stdin.on('error', reject);

    process.stdin.on('end', () => {
      const combined = Buffer.concat(chunks).toString('utf-8');
      const payload = combined.split(INPUT_SENTINEL)[0]!.trim();
      resolve(payload);
    });

    process.stdin.resume();
  });
}

// ─── Main ───────────────────────────────────────────

async function main(): Promise<void> {
  const output = new OutputChannel();

  try {
    // 1. Read payload from stdin
    const raw = await readStdin();
    const payload: Payload = JSON.parse(raw);

    // 2. Validate token
    const validator = new TokenValidator();
    const validation = validator.validate(payload.token);
    if (!validation.valid) {
      output.write({
        output: '',
        exit_reason: 'error',
        error: `Token validation failed: ${validation.reason}`,
        tool_calls: [],
        llm_calls_used: 0,
        tokens_used: 0,
        tool_calls_count: 0,
        artifacts: [],
      });
      process.exit(1);
    }

    // 3. Create resource tracker from token limits
    const tracker = new ResourceTracker(
      (payload.token.max_llm_calls as number) ?? 10,
      (payload.token.max_llm_tokens as number) ?? 20_000,
      (payload.token.max_tool_calls as number) ?? 20,
    );

    // 4. Create MCP proxy
    const proxyUrl = payload.mcp_proxy_url ?? 'http://localhost:3000/mcp';
    const proxy = new MCPProxy(proxyUrl);

    // 5. Create and run agent loop
    const systemPrompt =
      payload.system_prompt || 'You are a subagent. Complete the given task.';

    const loop = new AgentLoop(systemPrompt, stubLLM, proxy, tracker);
    const result = await loop.run(payload.task);

    // 6. Write result to stdout
    output.write({
      output: result.output,
      exit_reason: result.exit_reason,
      tool_calls: result.tool_calls,
      llm_calls_used: result.llm_calls_used,
      tokens_used: result.tokens_used,
      tool_calls_count: result.tool_calls.length,
      artifacts: [],
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    output.write({
      output: '',
      exit_reason: 'error',
      error: message,
      tool_calls: [],
      llm_calls_used: 0,
      tokens_used: 0,
      tool_calls_count: 0,
      artifacts: [],
    });
    process.exit(1);
  }
}

main();
