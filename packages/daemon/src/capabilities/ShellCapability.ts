import type { Capability, CapabilityResult, ToolDefinition } from './types.js';
import { spawn } from 'node:child_process';

export class ShellCapability implements Capability {
  readonly name = 'shell_exec';
  readonly description = 'Execute shell commands in the working directory.';

  readonly toolDefinition: ToolDefinition = {
    name: 'shell_exec',
    description: 'Execute a shell command. Use & for background processes. Returns stdout+stderr.',
    input_schema: {
      type: 'object',
      properties: {
        command:    { type: 'string', description: 'Shell command to execute' },
        timeout_ms: { type: 'number', description: 'Timeout (default 30000ms)' },
      },
      required: ['command'],
    },
  };

  async execute(input: Record<string, unknown>, cwd: string): Promise<CapabilityResult> {
    const command = String(input.command ?? '');
    const timeout = Number(input.timeout_ms ?? 30_000);
    const start = Date.now();

    return new Promise((resolve_) => {
      const chunks: string[] = [];
      const proc = spawn('bash', ['-c', command], {
        cwd,
        env: { ...process.env, TERM: 'dumb' },
        timeout,
      });
      proc.stdout.on('data', (d: Buffer) => chunks.push(d.toString()));
      proc.stderr.on('data', (d: Buffer) => chunks.push(d.toString()));
      proc.on('close', (code) => {
        const output = chunks.join('').trim();
        resolve_({
          success: code === 0,
          output: output || (code === 0 ? '(no output)' : `exit ${code}`),
          duration_ms: Date.now() - start,
          ...(code !== 0 && { error: `exit code ${code}` }),
        });
      });
      proc.on('error', (err) => {
        resolve_({ success: false, output: err.message, error: err.message, duration_ms: Date.now() - start });
      });
    });
  }
}
