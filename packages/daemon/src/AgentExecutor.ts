/**
 * AgentExecutor — the real agent loop.
 *
 * Takes a task, runs it through LLM tool-calling, actually executes
 * shell commands and file operations, streams tokens back, and returns
 * a structured result.
 *
 * Loop:
 *   1. LLM receives task + available tools
 *   2. LLM emits tool_calls (write_file, shell_exec, etc.)
 *   3. We execute the tools for real
 *   4. Results fed back to LLM
 *   5. Repeat until LLM returns end_turn (no more tool calls)
 *   6. Stream final response token by token
 */

import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import type { LLMExecutor, LLMMessage, LLMResponse } from './LLMExecutor.js';
import { AGENT_TOOLS } from './LLMExecutor.js';

export interface AgentResult {
  output: string;
  files_written: string[];
  commands_run: string[];
  tokens_used: number;
  model: string;
  iterations: number;
}

export interface AgentExecutorConfig {
  cwd: string;
  max_iterations?: number;
  max_command_ms?: number;
}

export class AgentExecutor {
  private cwd: string;
  private maxIterations: number;
  private maxCommandMs: number;

  constructor(
    private llm: LLMExecutor,
    private config: AgentExecutorConfig,
    private onStep: (step: string) => void,
    private onToken: (token: string) => void,
  ) {
    this.cwd = config.cwd;
    this.maxIterations = config.max_iterations ?? 20;
    this.maxCommandMs = config.max_command_ms ?? 30_000;
  }

  async execute(task: string, systemContext?: string): Promise<AgentResult> {
    const filesWritten: string[] = [];
    const commandsRun: string[] = [];
    let totalTokens = 0;
    let modelName = '';

    const systemPrompt = this.buildSystemPrompt(systemContext);
    const messages: LLMMessage[] = [
      { role: 'user', content: task },
    ];

    let finalOutput = '';

    for (let i = 0; i < this.maxIterations; i++) {
      this.onStep(i === 0 ? 'Thinking…' : 'Continuing…');

      let response: LLMResponse;
      try {
        response = await this.llm.completeWithTools(
          messages,
          AGENT_TOOLS,
          systemPrompt,
          // Only stream tokens on the final (non-tool) turn
          (token) => {
            this.onToken(token);
            finalOutput += token;
          },
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.onStep(`LLM error: ${msg}`);
        finalOutput = `Error: ${msg}`;
        break;
      }

      totalTokens += response.tokens_used;
      modelName = response.model;

      // No tool calls → we're done
      if (response.stop_reason === 'end_turn' || !response.tool_calls?.length) {
        if (!finalOutput && response.content) finalOutput = response.content;
        break;
      }

      // Reset streaming accumulator — this turn had tool calls, not final output
      finalOutput = '';

      // Append assistant message with tool calls
      messages.push({
        role: 'assistant',
        content: response.content,
        tool_calls: response.tool_calls,
      });

      // Execute each tool call
      for (const tc of response.tool_calls) {
        this.onStep(`▶ ${tc.name}(${this.summariseInput(tc.name, tc.input)})`);

        let result: string;
        try {
          result = await this.executeTool(tc.name, tc.input);
          // Track artifacts
          if (tc.name === 'write_file' && tc.input.path) {
            filesWritten.push(String(tc.input.path));
          }
          if (tc.name === 'shell_exec' && tc.input.command) {
            commandsRun.push(String(tc.input.command));
          }
        } catch (err) {
          result = `Error: ${err instanceof Error ? err.message : String(err)}`;
        }

        this.onStep(`  ↳ ${result.slice(0, 120)}${result.length > 120 ? '…' : ''}`);

        messages.push({
          role: 'tool',
          content: result,
          tool_call_id: tc.id,
        });
      }
    }

    return {
      output: finalOutput || '(no output)',
      files_written: filesWritten,
      commands_run: commandsRun,
      tokens_used: totalTokens,
      model: modelName,
      iterations: messages.filter(m => m.role === 'assistant').length,
    };
  }

  // ─── Tool execution ────────────────────────────────────────────────────────

  private async executeTool(name: string, input: Record<string, unknown>): Promise<string> {
    switch (name) {
      case 'shell_exec':
        return this.shellExec(
          String(input.command ?? ''),
          Number(input.timeout_ms ?? this.maxCommandMs),
        );
      case 'write_file':
        return this.writeFile(String(input.path ?? ''), String(input.content ?? ''));
      case 'read_file':
        return this.readFile(String(input.path ?? ''));
      case 'list_dir':
        return this.listDir(input.path ? String(input.path) : undefined);
      default:
        return `Unknown tool: ${name}`;
    }
  }

  private shellExec(command: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve) => {
      const chunks: string[] = [];
      const proc = spawn('bash', ['-c', command], {
        cwd: this.cwd,
        env: { ...process.env, TERM: 'dumb' },
        timeout: timeoutMs,
      });

      proc.stdout.on('data', (d: Buffer) => chunks.push(d.toString()));
      proc.stderr.on('data', (d: Buffer) => chunks.push(d.toString()));

      proc.on('close', (code) => {
        const output = chunks.join('').trim();
        resolve(output || (code === 0 ? '(command completed, no output)' : `exit code ${code}`));
      });

      proc.on('error', (err) => {
        resolve(`Error: ${err.message}`);
      });
    });
  }

  private writeFile(filePath: string, content: string): string {
    const safe = this.safePath(filePath);
    if (!safe) return 'Error: path outside working directory';
    mkdirSync(dirname(safe), { recursive: true });
    writeFileSync(safe, content, 'utf8');
    const rel = relative(this.cwd, safe);
    return `Written: ${rel} (${content.length} bytes)`;
  }

  private readFile(filePath: string): string {
    const safe = this.safePath(filePath);
    if (!safe) return 'Error: path outside working directory';
    if (!existsSync(safe)) return `File not found: ${filePath}`;
    const content = readFileSync(safe, 'utf8');
    // Truncate large files
    return content.length > 8000
      ? content.slice(0, 8000) + `\n…[truncated, ${content.length} total bytes]`
      : content;
  }

  private listDir(dirPath?: string): string {
    const safe = this.safePath(dirPath ?? '.');
    if (!safe) return 'Error: path outside working directory';
    if (!existsSync(safe)) return `Directory not found: ${dirPath}`;
    try {
      const entries = readdirSync(safe, { withFileTypes: true })
        .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules')
        .map(e => `${e.isDirectory() ? 'd' : 'f'}  ${e.name}`)
        .join('\n');
      return entries || '(empty directory)';
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private safePath(p: string): string | null {
    const resolved = resolve(this.cwd, p);
    return resolved.startsWith(this.cwd) ? resolved : null;
  }

  private buildSystemPrompt(extra?: string): string {
    const lines = [
      `You are 0agent, an AI software engineer. You can execute shell commands and manage files.`,
      `Working directory: ${this.cwd}`,
      ``,
      `Instructions:`,
      `- Use tools to actually accomplish tasks, don't just describe what to do`,
      `- For web servers: write the files, then start the server with & (background)`,
      `- For npm/node projects: check package.json first with read_file or list_dir`,
      `- After write_file, verify with read_file if needed`,
      `- After shell_exec, check output for errors and retry if needed`,
      `- Use relative paths from the working directory`,
      `- Be concise in your final response: state what was done and where to find it`,
    ];
    if (extra) lines.push(``, `Context:`, extra);
    return lines.join('\n');
  }

  private summariseInput(toolName: string, input: Record<string, unknown>): string {
    if (toolName === 'shell_exec') return `"${String(input.command ?? '').slice(0, 60)}"`;
    if (toolName === 'write_file') return `"${input.path}"`;
    if (toolName === 'read_file')  return `"${input.path}"`;
    if (toolName === 'list_dir')   return `"${input.path ?? '.'}"`;
    return JSON.stringify(input).slice(0, 60);
  }
}
