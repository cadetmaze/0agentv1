import { access, constants } from 'node:fs/promises';
import { platform } from 'node:os';
import type { ISandboxBackend, SandboxCreateConfig, SandboxHandle } from './types.js';

/**
 * Firecracker microVM backend — requires Linux with KVM support.
 *
 * Currently a stub: logs a warning and falls back to a no-op handle.
 * In production this would:
 *   1. Restore a pre-built microVM snapshot via the Firecracker API
 *   2. Communicate over vsock
 *   3. Provide full hardware-level isolation
 */
export class FirecrackerBackend implements ISandboxBackend {
  readonly type = 'firecracker';

  async isAvailable(): Promise<boolean> {
    if (platform() !== 'linux') return false;
    try {
      await access('/dev/kvm', constants.R_OK | constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  async create(config: SandboxCreateConfig): Promise<SandboxHandle> {
    const id = crypto.randomUUID();

    console.warn(
      `[sandbox:firecracker] Firecracker snapshot restore not yet implemented. ` +
      `Returning stub handle for sandbox ${id.slice(0, 8)}.`,
    );

    // Stub handle that acknowledges writes but produces no output
    const handle: SandboxHandle = {
      id,
      backend_type: 'firecracker',
      created_at: Date.now(),

      async write(_data: string): Promise<void> {
        console.warn('[sandbox:firecracker] write() called on stub handle — no-op');
      },

      async readOutput(): Promise<string> {
        return JSON.stringify({
          ok: false,
          error: 'Firecracker backend is not yet implemented. Use docker or process backend.',
          exit_reason: 'stub',
        });
      },

      async kill(): Promise<void> {
        // nothing to kill
      },
    };

    return handle;
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    await handle.kill();
  }
}
