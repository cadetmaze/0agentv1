/**
 * CodespaceManager — manages a GitHub Codespace as a cloud browser backend.
 *
 * Uses the `gh` CLI (already authenticated for memory sync).
 * The codespace runs the 0agent browser server on port 3000.
 * Access is via `gh codespace ports forward` — SSH tunnel, fully private.
 *
 * Flow:
 *   1. getOrCreate()  — find existing codespace or create from memory repo
 *   2. ensureRunning() — start if stopped (30s), create if missing (2-3 min first time)
 *   3. startBrowserServer() — ensure server.js is running inside
 *   4. openTunnel() — forward port 3000 to localhost:3001 via gh CLI
 *   5. Local daemon calls http://localhost:3001/browse
 *
 * Cost: 60 hours/month FREE on personal GitHub accounts.
 */

import { execSync, spawn, type ChildProcess } from 'node:child_process';

export type CodespaceState =
  | 'Available'   // running
  | 'Starting'    // warming up
  | 'Shutdown'    // stopped (state preserved, fast restart)
  | 'Deleted'
  | 'Unknown';

export interface CodespaceInfo {
  name: string;
  state: CodespaceState;
  displayName: string;
  repository: string;
}

// The memory repo serves double duty: stores the graph AND is the codespace template
const BROWSER_PORT_REMOTE = 3000;
const BROWSER_PORT_LOCAL  = 3001;  // forwarded to localhost
const DISPLAY_NAME        = '0agent-browser';
const FORWARD_TIMEOUT_S   = 60;

export class CodespaceManager {
  private forwardProcess: ChildProcess | null = null;
  private _ready = false;
  private _localUrl = `http://localhost:${BROWSER_PORT_LOCAL}`;
  private memoryRepo: string;  // e.g. "cadetmaze/0agent-memory"

  constructor(memoryRepo: string) {
    this.memoryRepo = memoryRepo;
  }

  /** Is the tunnel open and browser server responding? */
  isReady(): boolean { return this._ready; }

  /** URL to call the browser server (via SSH tunnel). */
  get localUrl(): string { return this._localUrl; }

  // ─── Main entry point ──────────────────────────────────────────────────────

  /**
   * Ensure the codespace is running, browser server is started, and tunnel is open.
   * Returns the local URL to call (http://localhost:3001).
   * First call: 2-3 minutes (cold provision). Subsequent: 30s or instant.
   */
  async getReadyUrl(): Promise<string> {
    const name = await this.ensureRunning();
    await this.startBrowserServer(name);
    await this.openTunnel(name);
    return this._localUrl;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  /** Find existing 0agent-browser codespace, or create one from the memory repo. */
  async getOrCreate(): Promise<string> {
    const existing = this.findExisting();
    if (existing) return existing.name;

    // Create codespace from the memory repo — it contains .devcontainer/
    console.log(`[Codespace] Creating browser codespace from ${this.memoryRepo}...`);
    console.log('[Codespace] First time: ~2-3 minutes. Subsequent starts: ~30 seconds.');

    try {
      const result = execSync(
        `gh codespace create --repo "${this.memoryRepo}" --machine basicLinux32gb --display-name "${DISPLAY_NAME}" --json name`,
        { encoding: 'utf8', timeout: 300_000 }
      );
      const parsed = JSON.parse(result.trim()) as { name: string };
      console.log(`[Codespace] Created: ${parsed.name}`);
      return parsed.name;
    } catch (err) {
      throw new Error(`Failed to create codespace: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Find the 0agent-browser codespace by display name. */
  findExisting(): CodespaceInfo | null {
    try {
      const out = execSync('gh codespace list --json name,state,displayName,repository', {
        encoding: 'utf8',
        timeout: 10_000,
      });
      const list = JSON.parse(out.trim()) as CodespaceInfo[];
      return list.find(c => c.displayName === DISPLAY_NAME) ?? null;
    } catch {
      return null;
    }
  }

  /** Ensure the codespace is in Available state. */
  async ensureRunning(): Promise<string> {
    const name = await this.getOrCreate();
    const info = this.findExisting();

    if (info?.state === 'Shutdown') {
      console.log('[Codespace] Starting stopped codespace (~30s)...');
      execSync(`gh codespace start --codespace "${name}"`, { timeout: 120_000 });
      await this.waitForState(name, 'Available', 60);
      console.log('[Codespace] Codespace is running');
    } else if (info?.state === 'Starting') {
      console.log('[Codespace] Codespace is starting...');
      await this.waitForState(name, 'Available', 120);
    }

    return name;
  }

  /** Start the browser server inside the codespace (idempotent). */
  async startBrowserServer(name: string): Promise<void> {
    try {
      execSync(
        `gh codespace exec --codespace "${name}" -- bash -c ` +
        `"pgrep -f 'node server.js' > /dev/null 2>&1 || ` +
        `(cd /workspaces && nohup node server.js > /tmp/browser-server.log 2>&1 &)"`,
        { timeout: 30_000 }
      );
    } catch {
      // Non-fatal: might already be running, or postStartCommand handled it
    }
  }

  /** Open an SSH tunnel via gh CLI: codespace:3000 → localhost:3001. */
  async openTunnel(name: string): Promise<void> {
    // Kill existing tunnel
    this.closeTunnel();

    console.log(`[Codespace] Opening tunnel port ${BROWSER_PORT_REMOTE} → localhost:${BROWSER_PORT_LOCAL}...`);

    this.forwardProcess = spawn(
      'gh',
      ['codespace', 'ports', 'forward', `${BROWSER_PORT_REMOTE}:${BROWSER_PORT_LOCAL}`, '--codespace', name],
      { stdio: ['ignore', 'ignore', 'ignore'] }
    );
    this.forwardProcess.unref();

    // Auto-restart tunnel if it dies
    this.forwardProcess.on('close', (code) => {
      if (this._ready) {
        console.log('[Codespace] Tunnel closed — reconnecting...');
        this._ready = false;
        this.openTunnel(name).catch(() => {});
      }
    });

    // Wait for the server to respond
    const deadline = Date.now() + FORWARD_TIMEOUT_S * 1000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 1000));
      try {
        const res = await fetch(`${this._localUrl}/health`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
          this._ready = true;
          console.log('[Codespace] Browser server ready at ' + this._localUrl);
          return;
        }
      } catch {}
    }

    throw new Error(`Browser server did not respond within ${FORWARD_TIMEOUT_S}s`);
  }

  closeTunnel(): void {
    if (this.forwardProcess) {
      try { this.forwardProcess.kill('SIGTERM'); } catch {}
      this.forwardProcess = null;
    }
    this._ready = false;
  }

  /** Stop the codespace to save free-tier hours. State is preserved. */
  async stop(): Promise<void> {
    this.closeTunnel();
    const info = this.findExisting();
    if (info?.state === 'Available') {
      execSync(`gh codespace stop --codespace "${info.name}"`, { timeout: 30_000 });
      console.log('[Codespace] Stopped (state preserved, restarts in 30s when needed)');
    }
  }

  /** Delete the codespace entirely. */
  async delete(): Promise<void> {
    this.closeTunnel();
    const info = this.findExisting();
    if (info) {
      execSync(`gh codespace delete --codespace "${info.name}" --force`, { timeout: 30_000 });
      console.log('[Codespace] Deleted');
    }
  }

  // ─── Health checking ───────────────────────────────────────────────────────

  /** Ping the browser server. Returns null if not reachable. */
  async ping(): Promise<{ ok: boolean; env: string } | null> {
    try {
      const res = await fetch(`${this._localUrl}/health`, { signal: AbortSignal.timeout(3000) });
      return res.ok ? (await res.json() as { ok: boolean; env: string }) : null;
    } catch {
      return null;
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private async waitForState(name: string, target: CodespaceState, maxSeconds: number): Promise<void> {
    for (let i = 0; i < maxSeconds / 2; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const info = this.findExisting();
      if (info?.state === target) return;
    }
    throw new Error(`Codespace did not reach ${target} state within ${maxSeconds}s`);
  }

  /** Check if gh CLI is installed and authenticated. */
  static isAvailable(): boolean {
    try {
      execSync('gh auth status', { stdio: 'ignore', timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }
}
