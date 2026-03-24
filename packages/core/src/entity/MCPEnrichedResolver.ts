/**
 * MCPEnrichedResolver — Async CRM/tool enrichment stub for 0agent Phase 4.
 *
 * In production this will kick off MCP tool calls to enrich entity data
 * (e.g., CRM lookup, external API calls) without blocking the main
 * resolution pipeline. Results are merged into the graph asynchronously.
 */

export class MCPEnrichedResolver {
  /**
   * Stage enrichment: kick off MCP tool calls, don't block resolution.
   *
   * Phase 4 stub: logs intent but does not actually call MCP.
   * In production: starts MCP call, merges results into graph asynchronously.
   */
  async enrichAsync(
    entityId: string,
    _toolName: string,
    _args: Record<string, unknown>,
  ): Promise<void> {
    console.log(`[MCPEnrich] Staging enrichment for entity ${entityId}`);
  }
}
