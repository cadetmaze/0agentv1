import type { ISandboxBackend, SandboxCreateConfig, SandboxHandle } from './types.js';

export interface CloudBackendOptions {
  /** E2B API key. If absent, the backend reports itself as unavailable. */
  apiKey?: string;
  /** Base URL for the E2B API (default: https://api.e2b.dev). */
  apiUrl?: string;
}

/**
 * E2B Cloud sandbox backend — delegates execution to a remote cloud VM.
 *
 * Currently a stub: the backend is only "available" when an API key is
 * configured, and create() returns an error result immediately.
 *
 * In production this would:
 *   1. Call the E2B API to provision a cloud sandbox
 *   2. Stream stdin/stdout over WebSocket
 *   3. Return a handle with the remote sandbox ID
 */
export class CloudBackend implements ISandboxBackend {
  readonly type = 'cloud';
  private readonly apiKey: string | undefined;
  private readonly apiUrl: string;

  constructor(options: CloudBackendOptions = {}) {
    this.apiKey = options.apiKey ?? process.env['E2B_API_KEY'];
    this.apiUrl = options.apiUrl ?? 'https://api.e2b.dev';
  }

  async isAvailable(): Promise<boolean> {
    return typeof this.apiKey === 'string' && this.apiKey.length > 0;
  }

  async create(config: SandboxCreateConfig): Promise<SandboxHandle> {
    const id = crypto.randomUUID();

    console.warn(
      `[sandbox:cloud] E2B Cloud sandbox not yet connected. ` +
      `API URL: ${this.apiUrl}, sandbox ${id.slice(0, 8)}.`,
    );

    const handle: SandboxHandle = {
      id,
      backend_type: 'cloud',
      created_at: Date.now(),

      async write(_data: string): Promise<void> {
        console.warn('[sandbox:cloud] write() called on stub handle — no-op');
      },

      async readOutput(): Promise<string> {
        return JSON.stringify({
          ok: false,
          error: 'E2B Cloud sandbox is not yet connected. Configure E2B_API_KEY and implement the Cloud backend.',
          exit_reason: 'stub',
        });
      },

      async kill(): Promise<void> {
        // nothing to kill — no remote sandbox was created
      },
    };

    return handle;
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    await handle.kill();
    // In production: call E2B API to terminate the remote sandbox
  }
}
