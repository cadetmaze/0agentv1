import type { ISandboxBackend, SandboxCreateConfig, SandboxHandle } from './types.js';

export type { ISandboxBackend, SandboxCreateConfig, SandboxHandle, InjectedFile } from './types.js';

export class SandboxManager {
  private backends: Map<string, ISandboxBackend> = new Map();
  private detectedBackend: string | null = null;

  registerBackend(backend: ISandboxBackend): void {
    this.backends.set(backend.type, backend);
  }

  /**
   * Auto-detect the best available backend.
   * Priority: firecracker > docker > podman > bwrap > cloud > process
   */
  async detectBackend(): Promise<string> {
    const priority = ['firecracker', 'docker', 'podman', 'bwrap', 'cloud', 'process'];

    for (const type of priority) {
      const backend = this.backends.get(type);
      if (backend && await backend.isAvailable()) {
        this.detectedBackend = type;
        return type;
      }
    }

    // process is always the fallback
    this.detectedBackend = 'process';
    return 'process';
  }

  async create(
    config: SandboxCreateConfig,
    preferredBackend?: string,
  ): Promise<SandboxHandle> {
    const type = preferredBackend ?? this.detectedBackend ?? await this.detectBackend();
    const backend = this.backends.get(type);
    if (!backend) {
      throw new Error(`Sandbox backend '${type}' not registered`);
    }
    return backend.create(config);
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    const backend = this.backends.get(handle.backend_type);
    if (backend) {
      await backend.destroy(handle);
    }
  }

  getDetectedBackend(): string | null {
    return this.detectedBackend;
  }

  getBackend(type: string): ISandboxBackend | undefined {
    return this.backends.get(type);
  }
}
