import type { Capability, CapabilityResult, ToolDefinition } from './types.js';
import { spawn } from 'node:child_process';

export class ShellCapability implements Capability {
  readonly name = 'shell_exec';
  readonly description = 'Execute shell commands in the working directory.';

  readonly toolDefinition: ToolDefinition = {
    name: 'shell_exec',
    description: 'Execute a shell command. For background servers use: cmd > /tmp/0agent-server.log 2>&1 &  Returns stdout+stderr.',
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
      let settled = false;

      const done = (code: number | null, signal?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const output = chunks.join('').trim();
        const success = code === 0 || (code === null && !!signal); // killed by signal counts as "ran"
        resolve_({
          success,
          output: output || (success ? '(no output)' : `exit ${code ?? signal}`),
          duration_ms: Date.now() - start,
          ...(!success && { error: `exit ${code ?? signal}` }),
        });
      };

      const proc = spawn('bash', ['-c', command], {
        cwd,
        env: { ...process.env, TERM: 'dumb' },
        // DO NOT set `timeout` here — we manage it manually via timer
        // so we can resolve on `exit` rather than waiting for `close`
      });

      proc.stdout.on('data', (d: Buffer) => chunks.push(d.toString()));
      proc.stderr.on('data', (d: Buffer) => chunks.push(d.toString()));

      // Use `exit` (not `close`) — fires when the bash process exits,
      // even if background child processes keep stdout/stderr open.
      // This prevents hanging when the command runs `something &`.
      proc.on('exit', (code) => done(code));

      proc.on('error', (err) => {
        settled = true;
        clearTimeout(timer);
        resolve_({ success: false, output: err.message, error: err.message, duration_ms: Date.now() - start });
      });

      // Manual timeout — kill bash and resolve with whatever we have
      const timer = setTimeout(() => {
        if (settled) return;
        try { proc.kill('SIGKILL'); } catch {}
        settled = true;
        const output = chunks.join('').trim();
        resolve_({
          success: false,
          output: output || '(timed out)',
          error: `timed out after ${timeout}ms`,
          duration_ms: Date.now() - start,
        });
      }, timeout);
    });
  }
}
