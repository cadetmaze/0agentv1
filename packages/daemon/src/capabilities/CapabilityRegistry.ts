import type { Capability, CapabilityResult, ToolDefinition } from './types.js';
import type { KnowledgeGraph } from '@0agent/core';
import { WebSearchCapability } from './WebSearchCapability.js';
import { BrowserCapability } from './BrowserCapability.js';
import { ScraperCapability } from './ScraperCapability.js';
import { ShellCapability } from './ShellCapability.js';
import { FileCapability } from './FileCapability.js';
import { MemoryCapability } from './MemoryCapability.js';
import { GUICapability } from './GUICapability.js';
import { OpenInterpreterCapability } from './OpenInterpreterCapability.js';

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
    this.register(new GUICapability());           // gui_automation: exec_js, click_text, type_in, get_elements, open_url, hotkey, browser_state
    this.register(new OpenInterpreterCapability()); // computer_use: autonomous multi-step tasks via Open Interpreter

    // Memory capability — only available when graph is connected
    if (graph) {
      this.register(new MemoryCapability(graph, onMemoryWrite));
    }
  }

  /**
   * Set the entity node ID on the memory capability so edges connect to the right user.
   * Called per-session before execution starts.
   */
  setEntityNodeId(id: string): void {
    const mem = this.capabilities.get('memory_write') as MemoryCapability | undefined;
    mem?.setEntityNodeId?.(id);
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

  /**
   * Return tool definitions relevant to a given task (progressive disclosure).
   * Core tools (shell, file, memory) are always included. Web/GUI tools only
   * when the task implies they're needed — saves ~200 tokens per turn.
   */
  getToolDefinitionsFor(task: string): ToolDefinition[] {
    const lower = task.toLowerCase();

    const active = new Set(['shell_exec', 'file_op']);
    if (this.capabilities.has('memory_write')) active.add('memory_write');

    if (/search|web|browse|scrape|research|website|url|http|google|fetch|crawl|find.*online/i.test(lower)) {
      active.add('web_search');
      active.add('scrape_url');
      active.add('browser_open');
    }

    // computer_use + gui_automation for interactive GUI, browser, and keyboard/mouse tasks
    if (/click|screenshot|ui|desktop|window|screen|gui|mouse|keyboard|open.*app|fill.*form|navigate.*browser|interact|automate|computer.*use|whatsapp|telegram|youtube|music|play|pause|resume|stop|skip|next.*track|prev|send.*message/i.test(lower)) {
      active.add('computer_use');
      active.add('gui_automation'); // exec_js, browser_state, open_url live here
    }

    return [...this.capabilities.values()]
      .filter(c => active.has(c.name))
      .map(c => c.toolDefinition);
  }

  async execute(toolName: string, input: Record<string, unknown>, cwd: string, signal?: AbortSignal): Promise<CapabilityResult> {
    const cap = this.capabilities.get(toolName);
    if (!cap) {
      return { success: false, output: `Unknown capability: ${toolName}`, duration_ms: 0 };
    }
    try {
      return await cap.execute(input, cwd, signal);
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
