/**
 * CodespaceBrowserCapability — uses a GitHub Codespace as the browser backend.
 *
 * SECURITY: Only spawned by AUTHORISED subagents (trust_level: 1, task_type: browser_task).
 * The main agent (Level 0) does NOT directly spin up the codespace.
 * The SubagentOrchestrator creates capability tokens that include 'browser_open' in allowed_tools
 * only for browser_task subagents.
 *
 * The codespace manager is lazy: it only provisions/starts the codespace when a
 * browser_task subagent actually needs to use it.
 */

import type { Capability, CapabilityResult, ToolDefinition } from './types.js';
import type { CodespaceManager } from '../CodespaceManager.js';
import { BrowserCapability } from './BrowserCapability.js';

export class CodespaceBrowserCapability implements Capability {
  readonly name = 'browser_open';
  readonly description = 'Open a URL in a cloud Linux browser (GitHub Codespace). Full JS, screenshots, clicks. Falls back to local Chrome.';
  private fallback = new BrowserCapability();
  private provisioningPromise: Promise<string> | null = null;

  readonly toolDefinition: ToolDefinition = {
    name: 'browser_open',
    description: 'Open URL in cloud Linux browser (GitHub Codespace). Handles JS-heavy SPAs, auth flows, screenshots. Fallback: local Chrome.',
    input_schema: {
      type: 'object',
      properties: {
        url:      { type: 'string',  description: 'URL to open' },
        action:   { type: 'string',  description: '"read" (default) | "screenshot" | "links" | "click" | "fill" | "snapshot"' },
        selector: { type: 'string',  description: 'CSS selector for element to extract or interact with' },
        wait_for: { type: 'string',  description: 'CSS selector to wait for before extracting' },
        wait_ms:  { type: 'number',  description: 'Additional wait after page load (for JS-heavy pages)' },
        value:    { type: 'string',  description: 'Value to fill (for action: fill)' },
      },
      required: ['url'],
    },
  };

  constructor(private manager: CodespaceManager) {}

  async execute(input: Record<string, unknown>, cwd: string): Promise<CapabilityResult> {
    const start = Date.now();

    // Ensure only one provision attempt at a time (concurrent calls share the same promise)
    try {
      if (!this.manager.isReady()) {
        if (!this.provisioningPromise) {
          this.provisioningPromise = this.manager.getReadyUrl().finally(() => {
            this.provisioningPromise = null;
          });
        }
        await this.provisioningPromise;
      }

      // Make the browser request to the codespace (via SSH tunnel)
      const res = await fetch(`${this.manager.localUrl}/browse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(60_000),
      });

      const data = await res.json() as Record<string, unknown>;
      if (!data.ok) throw new Error(String(data.error ?? 'Browse failed'));

      return {
        success: true,
        output: String(data.data ?? ''),
        structured: data,
        duration_ms: Date.now() - start,
      };
    } catch (err) {
      // If codespace fails, fall back to local Chrome
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn('[CodespaceBrowser] Falling back to local Chrome:', errMsg);

      const result = await this.fallback.execute(input, cwd);
      return {
        ...result,
        fallback_used: 'local-chrome',
        duration_ms: Date.now() - start,
      };
    }
  }
}
