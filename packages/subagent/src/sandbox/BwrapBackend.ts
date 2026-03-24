import { spawn, exec, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { platform } from 'node:os';
import type { ISandboxBackend, SandboxCreateConfig, SandboxHandle } from './types.js';

const execAsync = promisify(exec);

const INPUT_SENTINEL = '__PAYLOAD_END__';
const OUTPUT_SENTINEL = '__OUTPUT_END__';

/**
 * Bubblewrap (bwrap) backend — Linux-only namespace isolation
 * without requiring root or a container daemon.
 *
 * Uses unshare for PID/net/user namespaces and bind-mounts for filesystem isolation.
 */
export class BwrapBackend implements ISandboxBackend {
  readonly type = 'bwrap';

  async isAvailable(): Promise<boolean> {
    if (platform() !== 'linux') return false;
    try {
      await execAsync('bwrap --version', { timeout: 3_000 });
      return true;
    } catch {
      return false;
    }
  }

  async create(config: SandboxCreateConfig): Promise<SandboxHandle> {
    const id = crypto.randomUUID();
    const runtime = 'node'; // use node; Bun detection deferred to production

    const bwrapArgs: string[] = [
      '--unshare-all',
      // Read-only bind the host root
      '--ro-bind', '/', '/',
      // Writable tmpfs mounts
      '--tmpfs', '/tmp',
      '--dev', '/dev',
      '--proc', '/proc',
      // Drop capabilities
      '--cap-drop', 'ALL',
      '--die-with-parent',
    ];

    // Network isolation
    if (config.network === 'none') {
      bwrapArgs.push('--unshare-net');
    }

    // Inject environment variables
    for (const [k, v] of Object.entries(config.env)) {
      bwrapArgs.push('--setenv', k, v);
    }
    bwrapArgs.push('--setenv', 'SANDBOX_TYPE', 'bwrap');
    bwrapArgs.push('--setenv', 'SANDBOX_ID', id);

    // The command to execute inside the sandbox
    bwrapArgs.push('--', runtime, '--input-type=module', '-e', WORKER_SCRIPT);

    const proc: ChildProcess = spawn('bwrap', bwrapArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let outputBuffer = '';
    let outputResolve: ((value: string) => void) | null = null;
    let outputReject: ((reason: Error) => void) | null = null;

    proc.stdout!.on('data', (chunk: Buffer) => {
      outputBuffer += chunk.toString();
      const idx = outputBuffer.indexOf(OUTPUT_SENTINEL);
      if (idx !== -1 && outputResolve) {
        const result = outputBuffer.slice(0, idx);
        outputBuffer = outputBuffer.slice(idx + OUTPUT_SENTINEL.length + 1);
        outputResolve(result);
        outputResolve = null;
        outputReject = null;
      }
    });

    proc.stderr!.on('data', (chunk: Buffer) => {
      process.stderr.write(`[sandbox:bwrap:${id.slice(0, 8)}] ${chunk.toString()}`);
    });

    proc.on('error', (err) => {
      if (outputReject) {
        outputReject(err);
        outputResolve = null;
        outputReject = null;
      }
    });

    proc.on('close', (code) => {
      if (outputReject) {
        outputReject(new Error(`Bwrap process exited with code ${code}`));
        outputResolve = null;
        outputReject = null;
      }
    });

    const handle: SandboxHandle = {
      id,
      backend_type: 'bwrap',
      created_at: Date.now(),

      async write(data: string): Promise<void> {
        return new Promise<void>((resolve, reject) => {
          if (!proc.stdin!.writable) {
            reject(new Error('Bwrap stdin is not writable'));
            return;
          }
          proc.stdin!.write(data + '\n' + INPUT_SENTINEL + '\n', (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      },

      readOutput(): Promise<string> {
        const idx = outputBuffer.indexOf(OUTPUT_SENTINEL);
        if (idx !== -1) {
          const result = outputBuffer.slice(0, idx);
          outputBuffer = outputBuffer.slice(idx + OUTPUT_SENTINEL.length + 1);
          return Promise.resolve(result);
        }
        return new Promise<string>((resolve, reject) => {
          outputResolve = resolve;
          outputReject = reject;
        });
      },

      async kill(): Promise<void> {
        try {
          proc.kill('SIGKILL');
        } catch {
          // already dead
        }
      },
    };

    return handle;
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    await handle.kill();
  }
}

/** Inline worker script — same protocol as ProcessBackend. */
const WORKER_SCRIPT = `
import { createInterface } from 'node:readline';

const INPUT_SENTINEL = '${INPUT_SENTINEL}';
const OUTPUT_SENTINEL = '${OUTPUT_SENTINEL}';

let buffer = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const idx = buffer.indexOf(INPUT_SENTINEL);
  if (idx !== -1) {
    const payload = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + INPUT_SENTINEL.length + 1);
    handlePayload(payload);
  }
});

async function handlePayload(raw) {
  let result;
  try {
    const payload = JSON.parse(raw);
    if (payload.type === 'exec') {
      const fn = new Function('return (async () => {' + payload.code + '})()');
      const output = await fn();
      result = { ok: true, output: output ?? null };
    } else if (payload.type === 'ping') {
      result = { ok: true, pong: true };
    } else {
      result = { ok: false, error: 'Unknown payload type: ' + payload.type };
    }
  } catch (err) {
    result = { ok: false, error: String(err) };
  }
  process.stdout.write(JSON.stringify(result) + '\\n' + OUTPUT_SENTINEL + '\\n');
}
`;
