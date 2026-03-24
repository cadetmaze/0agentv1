import type { MCPServerConfig, MCPTool, MCPCallResult, MCPConnection } from './types.js';
import { MCPDiscovery } from './MCPDiscovery.js';
import { FilteredProxy } from './FilteredProxy.js';

export class MCPHub {
  private connections: Map<string, MCPConnection> = new Map();
  private toolRegistry: Map<string, MCPTool> = new Map();  // tool name -> MCPTool

  constructor(private configs: MCPServerConfig[]) {}

  /**
   * Connect to all configured MCP servers.
   * In Phase 2: just register the configs and their tools (no real MCP protocol yet).
   * Real MCP protocol connection happens when @modelcontextprotocol/sdk is wired in.
   */
  async connectAll(): Promise<void> {
    for (const config of this.configs) {
      if (!config.enabled) continue;
      this.connections.set(config.name, {
        config,
        tools: [],   // populated when real MCP connects
        connected: false,
        error: 'stub — real MCP connection not yet implemented',
      });
    }
  }

  /**
   * Auto-discover MCP servers from the project directory.
   */
  discoverFromProject(cwd: string): MCPServerConfig[] {
    const discovery = new MCPDiscovery();
    const results = discovery.discover(cwd);
    const servers: MCPServerConfig[] = [];
    for (const result of results) {
      servers.push(...result.servers);
    }
    return servers;
  }

  /**
   * Register tools for a server (called after real MCP handshake).
   */
  registerTools(serverName: string, tools: MCPTool[]): void {
    const conn = this.connections.get(serverName);
    if (conn) {
      conn.tools = tools;
      conn.connected = true;
      conn.error = undefined;
    }
    for (const tool of tools) {
      this.toolRegistry.set(tool.name, { ...tool, server_name: serverName });
    }
  }

  /**
   * List all registered tools across all servers.
   */
  listTools(): MCPTool[] {
    return [...this.toolRegistry.values()];
  }

  /**
   * Call a tool on its server.
   * Phase 2 stub: returns error for all calls (no real MCP connection).
   */
  async callTool(serverName: string, toolName: string, args: unknown): Promise<MCPCallResult> {
    const conn = this.connections.get(serverName);
    if (!conn) {
      return { content: [{ type: 'text', text: `Server '${serverName}' not found` }], isError: true };
    }
    if (!conn.connected) {
      return { content: [{ type: 'text', text: `Server '${serverName}' not connected` }], isError: true };
    }
    // Phase 2: stub
    return { content: [{ type: 'text', text: `MCP call stub: ${toolName}(${JSON.stringify(args)})` }], isError: false };
  }

  /**
   * Create a filtered proxy with only allowed tools.
   */
  createFilteredProxy(allowedTools: string[]): FilteredProxy {
    return new FilteredProxy(
      allowedTools,
      (server, tool, args) => this.callTool(server, tool, args),
      this.listTools(),
    );
  }

  /**
   * Get connection status for all servers.
   */
  getConnections(): MCPConnection[] {
    return [...this.connections.values()];
  }

  /**
   * Number of connected servers.
   */
  get connectionCount(): number {
    return [...this.connections.values()].filter(c => c.connected).length;
  }

  /**
   * Disconnect all servers.
   */
  async disconnectAll(): Promise<void> {
    this.connections.clear();
    this.toolRegistry.clear();
  }
}
