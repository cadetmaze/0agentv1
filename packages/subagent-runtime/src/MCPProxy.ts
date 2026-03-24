/**
 * MCPProxy — connects to the parent daemon's filtered MCP proxy endpoint.
 *
 * In Phase 3 this is a stub that logs calls and returns mock results.
 * The real implementation will issue HTTP requests to the daemon's
 * per-subagent MCP proxy endpoint, which filters tool access based on
 * the capability token's allowed_tools list.
 */
export class MCPProxy {
  constructor(private readonly proxyUrl: string) {}

  /**
   * Call a tool through the MCP proxy.
   */
  async call(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    // Phase 3 stub — log and return mock result.
    // Real implementation: POST to proxyUrl with { tool_name, args }
    console.log(`[MCPProxy] ${toolName}(${JSON.stringify(args)})`);
    return { type: 'text', text: `Stub: ${toolName} called` };
  }

  /**
   * List tools available through the proxy.
   */
  async listTools(): Promise<Array<{ name: string; description: string }>> {
    // Phase 3 stub — real implementation: GET proxyUrl/tools
    return [];
  }
}
