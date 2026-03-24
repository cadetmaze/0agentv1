import type { MCPTool, MCPCallResult } from './types.js';

export class FilteredProxy {
  constructor(
    private allowedTools: string[],
    private callFn: (serverName: string, toolName: string, args: unknown) => Promise<MCPCallResult>,
    private allTools: MCPTool[],
  ) {}

  /**
   * Get only the tools this proxy allows.
   */
  listTools(): MCPTool[] {
    return this.allTools.filter(t => this.allowedTools.includes(t.name));
  }

  /**
   * Call a tool -- rejects if not in allowed list.
   */
  async callTool(toolName: string, args: unknown): Promise<MCPCallResult> {
    if (!this.allowedTools.includes(toolName)) {
      return {
        content: [{ type: 'text', text: `Tool '${toolName}' is not allowed by capability token` }],
        isError: true,
      };
    }
    // Find which server owns this tool
    const tool = this.allTools.find(t => t.name === toolName);
    if (!tool) {
      return {
        content: [{ type: 'text', text: `Tool '${toolName}' not found in registry` }],
        isError: true,
      };
    }
    return this.callFn(tool.server_name, toolName, args);
  }

  /**
   * Check if a tool is allowed.
   */
  isAllowed(toolName: string): boolean {
    return this.allowedTools.includes(toolName);
  }
}
