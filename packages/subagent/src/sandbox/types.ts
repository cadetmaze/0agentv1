/**
 * Shared types for sandbox backends.
 */

export interface InjectedFile {
  path: string;
  content: string;
  mode?: number;
}

export interface SandboxCreateConfig {
  image?: string;
  memory_mb: number;
  cpus: number;
  network: 'none' | 'allowlist' | 'full';
  network_allowlist?: string[];
  has_browser: boolean;
  has_display: boolean;
  env: Record<string, string>;
  inject_files: InjectedFile[];
}

export interface SandboxHandle {
  id: string;
  backend_type: string;
  created_at: number;
  vnc_port?: number;
  write(data: string): Promise<void>;
  readOutput(): Promise<string>;
  kill(): Promise<void>;
}

export interface ISandboxBackend {
  readonly type: string;
  isAvailable(): Promise<boolean>;
  create(config: SandboxCreateConfig): Promise<SandboxHandle>;
  destroy(handle: SandboxHandle): Promise<void>;
}
