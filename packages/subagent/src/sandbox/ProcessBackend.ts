import { spawn, type ChildProcess } from 'node:child_process';
import type { ISandboxBackend, SandboxCreateConfig, SandboxHandle } from './types.js';

const INPUT_SENTINEL = '__PAYLOAD_END__';
const OUTPUT_SENTINEL = '__OUTPUT_END__';

/**
 * Simplest sandbox backend — spawns a child process with minimal isolation.
 * Always available as the last-resort fallback.
 *
 * Communication protocol:
 *   stdin  → JSON payload + INPUT_SENTINEL newline
 *   stdout ← JSON result  + OUTPUT_SENTINEL newline
 */
export class ProcessBackend implements ISandboxBackend {
  readonly type = 'process';

  async isAvailable(): Promise<boolean> {
    return true; // always available
  }

  async create(config: SandboxCreateConfig): Promise<SandboxHandle> {
    const id = crypto.randomUUID();

    // Detect runtime: prefer bun if available, else node
    const runtime = 'node'; // use node; Bun detection deferred to production

    const child: ChildProcess = spawn(runtime, ['--input-type=module', '-e', WORKER_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...config.env,
        SANDBOX_TYPE: 'process',
        SANDBOX_ID: id,
      },
    });

    // Buffer stdout chunks until we see the sentinel
    let outputBuffer = '';
    let outputResolve: ((value: string) => void) | null = null;
    let outputReject: ((reason: Error) => void) | null = null;

    child.stdout!.on('data', (chunk: Buffer) => {
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

    child.stderr!.on('data', (chunk: Buffer) => {
      process.stderr.write(`[sandbox:process:${id.slice(0, 8)}] ${chunk.toString()}`);
    });

    child.on('error', (err) => {
      if (outputReject) {
        outputReject(err);
        outputResolve = null;
        outputReject = null;
      }
    });

    child.on('close', (code) => {
      if (outputReject) {
        outputReject(new Error(`Process exited with code ${code}`));
        outputResolve = null;
        outputReject = null;
      }
    });

    const handle: SandboxHandle = {
      id,
      backend_type: 'process',
      created_at: Date.now(),

      async write(data: string): Promise<void> {
        return new Promise<void>((resolve, reject) => {
          if (!child.stdin!.writable) {
            reject(new Error('Process stdin is not writable'));
            return;
          }
          child.stdin!.write(data + '\n' + INPUT_SENTINEL + '\n', (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      },

      readOutput(): Promise<string> {
        // Check if we already have a complete message buffered
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
          child.kill('SIGKILL');
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

/**
 * Inline worker script executed inside the child process.
 * Reads JSON payloads delimited by INPUT_SENTINEL from stdin,
 * evaluates them, and writes results delimited by OUTPUT_SENTINEL to stdout.
 */
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
      const { code } = payload;
      const fn = new Function('return (async () => {' + code + '})()');
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
