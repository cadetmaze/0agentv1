import type { Capability, CapabilityResult, ToolDefinition } from './types.js';
import { WebSearchCapability } from './WebSearchCapability.js';
import { BrowserCapability } from './BrowserCapability.js';
import { ScraperCapability } from './ScraperCapability.js';
import { ShellCapability } from './ShellCapability.js';
import { FileCapability } from './FileCapability.js';

export class CapabilityRegistry {
  private capabilities = new Map<string, Capability>();

  constructor() {
    this.register(new WebSearchCapability());
    this.register(new BrowserCapability());
    this.register(new ScraperCapability());
    this.register(new ShellCapability());
    this.register(new FileCapability());
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
