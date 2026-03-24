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

  // Commands that create persistent OS-level scheduled tasks.
  // These must never run autonomously — they survive uninstall and can
  // re-open apps (e.g. Brave) on every login or on a timer.
  private static PERSISTENT_TASK_PATTERN = /crontab\s+-[eilr]|launchctl\s+load|launchctl\s+bootstrap|systemctl\s+enable|at\s+\d|make\s+login\s+item|LaunchAgents|LaunchDaemons|loginitems/i;

  // Commands that make irreversible external state changes — require explicit user confirmation
  private static DESTRUCTIVE_PATTERN = /\bcurl\s+[^|&]*-[A-Za-z]*[XD]\s+(DELETE|POST|PUT|PATCH)\b|\bcurl\s+[^|&]*--(request|data)[=\s]+(DELETE|POST|PUT|PATCH)\b|rm\s+-[rf]{1,3}\s+[^|&;]{3}|DROP\s+TABLE|DELETE\s+FROM\s+\w/i;

  async execute(input: Record<string, unknown>, cwd: string, signal?: AbortSignal): Promise<CapabilityResult> {
    let command = String(input.command ?? '');
    const timeout = Number(input.timeout_ms ?? 30_000);
    const start = Date.now();

    // Block commands that create persistent scheduled tasks.
    // These survive agent uninstall and can keep launching apps indefinitely.
    if (ShellCapability.PERSISTENT_TASK_PATTERN.test(command)) {
      return {
        success: false,
        output: `Blocked: "${command.slice(0, 80)}" creates a persistent scheduled task (cron/launchd/login item). ` +
          `These survive uninstall and can keep launching apps autonomously. ` +
          `Ask the user explicitly before scheduling any persistent OS task.`,
        duration_ms: 0,
      };
    }

    // Require explicit confirmation before irreversible external mutations
    if (ShellCapability.DESTRUCTIVE_PATTERN.test(command)) {
      return {
        success: false,
        output: `CONFIRM_REQUIRED: The command "${command.slice(0, 100)}" will make an irreversible change. ` +
          `Tell the user exactly what this will do and ask them to reply with explicit confirmation before you run it.`,
        duration_ms: 0,
      };
    }

    if (signal?.aborted) {
      return { success: false, output: 'Cancelled.', duration_ms: 0 };
    }

    // Auto-redirect background processes to prevent FD inheritance.
    if (/&\s*$/.test(command) && !/[>|].*&\s*$/.test(command)) {
      const logFile = `/tmp/0agent-bg-${Date.now()}.log`;
      command = command.replace(/\s*&\s*$/, ` > ${logFile} 2>&1 &`);
    }

    return new Promise((resolve_) => {
      const chunks: string[] = [];
      let settled = false;

      const done = (code: number | null, killedBySignal?: string) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        clearTimeout(timer);
        const output = chunks.join('').trim();
        const success = code === 0 || (code === null && !!killedBySignal);
        resolve_({
          success,
          output: output || (success ? '(no output)' : `exit ${code ?? killedBySignal}`),
          duration_ms: Date.now() - start,
          ...(!success && { error: `exit ${code ?? killedBySignal}` }),
        });
      };

      const proc = spawn('bash', ['-c', command], {
        cwd,
        env: { ...process.env, TERM: 'dumb' },
      });

      // Kill immediately when ESC is pressed
      const onAbort = () => {
        try { proc.kill('SIGKILL'); } catch {}
        if (!settled) {
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          clearTimeout(timer);
          resolve_({ success: false, output: chunks.join('').trim() || 'Cancelled.', duration_ms: Date.now() - start });
        }
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      proc.stdout.on('data', (d: Buffer) => chunks.push(d.toString()));
      proc.stderr.on('data', (d: Buffer) => chunks.push(d.toString()));
      proc.on('exit', (code) => done(code));
      proc.on('error', (err) => {
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        clearTimeout(timer);
        resolve_({ success: false, output: err.message, error: err.message, duration_ms: Date.now() - start });
      });

      const timer = setTimeout(() => {
        if (settled) return;
        try { proc.kill('SIGKILL'); } catch {}
        settled = true;
        signal?.removeEventListener('abort', onAbort);
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
