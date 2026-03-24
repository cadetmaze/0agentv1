import { spawn, exec, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import type { ISandboxBackend, SandboxCreateConfig, SandboxHandle } from './types.js';

const execAsync = promisify(exec);

const INPUT_SENTINEL = '__PAYLOAD_END__';
const OUTPUT_SENTINEL = '__OUTPUT_END__';

/**
 * Docker container backend with resource limits, read-only root,
 * and optional network isolation.
 */
export class DockerBackend implements ISandboxBackend {
  readonly type = 'docker';

  async isAvailable(): Promise<boolean> {
    try {
      await execAsync('docker info', { timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }

  async create(config: SandboxCreateConfig): Promise<SandboxHandle> {
    const id = crypto.randomUUID();
    const args = this.buildRunArgs(id, config);

    const proc: ChildProcess = spawn('docker', args, {
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
      process.stderr.write(`[sandbox:docker:${id.slice(0, 8)}] ${chunk.toString()}`);
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
        outputReject(new Error(`Docker container exited with code ${code}`));
        outputResolve = null;
        outputReject = null;
      }
    });

    const handle: SandboxHandle = {
      id,
      backend_type: 'docker',
      created_at: Date.now(),

      async write(data: string): Promise<void> {
        return new Promise<void>((resolve, reject) => {
          if (!proc.stdin!.writable) {
            reject(new Error('Docker stdin is not writable'));
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
    // Force-remove by label in case --rm did not clean up
    try {
      await execAsync(
        `docker rm -f $(docker ps -aq --filter "label=0agent-sandbox=${handle.id}") 2>/dev/null`,
        { timeout: 5_000 },
      );
    } catch {
      // ignore — container may already be removed
    }
  }

  /** Build the `docker run` argument list from config. */
  private buildRunArgs(id: string, config: SandboxCreateConfig): string[] {
    const args: string[] = [
      'run', '--rm', '--interactive',
      `--memory=${config.memory_mb}m`,
      `--cpus=${config.cpus}`,
      '--read-only',
      '--tmpfs', '/tmp:size=100m',
      '--tmpfs', '/root/.bun:size=50m',
      '--security-opt', 'no-new-privileges',
      '--label', `0agent-sandbox=${id}`,
    ];

    // --- Network isolation ---
    if (config.network === 'none') {
      args.push('--network=none');
    } else if (config.network === 'allowlist') {
      args.push('--network=bridge');
      if (config.network_allowlist?.length) {
        args.push('--env', `NETWORK_ALLOWLIST=${config.network_allowlist.join(',')}`);
      }
    }
    // 'full' → default docker bridge, no extra flags

    // --- Display / VNC ---
    if (config.has_display) {
      args.push('--env', 'DISPLAY=:99');
    }

    // --- Environment variables ---
    for (const [k, v] of Object.entries(config.env)) {
      args.push('--env', `${k}=${v}`);
    }

    // --- Image selection ---
    const image = config.image
      ?? (config.has_browser
        ? '0agent/subagent-runtime:chrome'
        : '0agent/subagent-runtime:latest');
    args.push(image);

    return args;
  }
}
