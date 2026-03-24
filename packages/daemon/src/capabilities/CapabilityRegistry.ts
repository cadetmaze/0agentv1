import type { Capability, CapabilityResult, ToolDefinition } from './types.js';
import type { KnowledgeGraph } from '@0agent/core';
import { WebSearchCapability } from './WebSearchCapability.js';
import { BrowserCapability } from './BrowserCapability.js';
import { ScraperCapability } from './ScraperCapability.js';
import { ShellCapability } from './ShellCapability.js';
import { FileCapability } from './FileCapability.js';
import { MemoryCapability } from './MemoryCapability.js';

export class CapabilityRegistry {
  private capabilities = new Map<string, Capability>();

  /**
   * Constructor optionally accepts a CodespaceManager.
   * If provided and the gh CLI is available, uses CodespaceBrowserCapability
   * for browser_open — cloud Linux browser via SSH tunnel.
   *
   * SECURITY: The registry is only instantiated inside AgentExecutor,
   * which is only created for AUTHORISED subagents (trust_level: 1,
   * task_type: browser_task). The main agent does NOT have direct access
   * to browser_open without going through a subagent spawn.
   */
  constructor(codespaceManager?: unknown, graph?: KnowledgeGraph, onMemoryWrite?: () => void) {
    this.register(new WebSearchCapability());

    // Browser capability: use Codespace if available, otherwise local Chrome
    if (codespaceManager) {
      try {
        const { CodespaceBrowserCapability } = require('./CodespaceBrowserCapability.js');
        this.register(new CodespaceBrowserCapability(codespaceManager));
      } catch {
        this.register(new BrowserCapability());
      }
    } else {
      this.register(new BrowserCapability());
    }

    this.register(new ScraperCapability());
    this.register(new ShellCapability());
    this.register(new FileCapability());

    // Memory capability — only available when graph is connected
    if (graph) {
      this.register(new MemoryCapability(graph, onMemoryWrite));
    }
  }

  register(cap: Capability): void {
    this.capabilities.set(cap.name, cap);
  }

  get(name: string): Capability | undefined {
    return this.capabilities.get(name);
  }

  getToolDefinitions(): ToolDefinition[] {
    return [...this.capabilities.values()].map(c => c.toolDefinition);
  }

  async execute(toolName: string, input: Record<string, unknown>, cwd: string): Promise<CapabilityResult> {
    const cap = this.capabilities.get(toolName);
    if (!cap) {
      return { success: false, output: `Unknown capability: ${toolName}`, duration_ms: 0 };
    }
    try {
      return await cap.execute(input, cwd);
    } catch (err) {
      return {
        success: false,
        output: `Capability error: ${err instanceof Error ? err.message : String(err)}`,
        duration_ms: 0,
      };
    }
  }

  list(): Array<{ name: string; description: string }> {
    return [...this.capabilities.values()].map(c => ({ name: c.name, description: c.description }));
  }
}
