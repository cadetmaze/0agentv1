import type { Capability, CapabilityResult, ToolDefinition } from './types.js';
import type { KnowledgeGraph } from '@0agent/core';
import { NodeType, createNode } from '@0agent/core';

export class MemoryCapability implements Capability {
  readonly name = 'memory_write';
  readonly description = 'Persist a discovered fact to long-term memory so it survives across sessions.';

  readonly toolDefinition: ToolDefinition = {
    name: 'memory_write',
    description:
      'Write an important fact to long-term memory. ' +
      'Call this whenever you discover something worth remembering: ' +
      'URLs (ngrok, live servers), file paths, port numbers, API endpoints, ' +
      'configuration values, decisions made, or task outcomes. ' +
      'Examples: memory_write({label:"ngrok_url", content:"https://abc.ngrok.io", type:"url"}) ' +
      'or memory_write({label:"project_port", content:"3000", type:"config"})',
    input_schema: {
      type: 'object',
      properties: {
        label:   { type: 'string', description: 'Short name for this fact (e.g. "ngrok_url", "project_port")' },
        content: { type: 'string', description: 'The value to remember' },
        type:    { type: 'string', description: 'Category: "url", "path", "config", "note", "outcome"' },
      },
      required: ['label', 'content'],
    },
  };

  constructor(private graph: KnowledgeGraph) {}

  async execute(input: Record<string, unknown>, _cwd: string): Promise<CapabilityResult> {
    const label   = String(input.label   ?? '').trim();
    const content = String(input.content ?? '').trim();
    const type    = String(input.type    ?? 'note').trim();
    const start   = Date.now();

    if (!label || !content) {
      return { success: false, output: 'label and content are required', duration_ms: 0 };
    }

    try {
      const nodeId = `memory:${label.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`;

      // Check if it already exists — update metadata if so
      const existing = this.graph.getNode(nodeId);
      if (existing) {
        this.graph.updateNode(nodeId, {
          label,
          metadata: { ...existing.metadata, content, type, updated_at: new Date().toISOString() },
        });
      } else {
        const node = createNode({
          id: nodeId,
          graph_id: 'root',
          label,
          type: NodeType.CONTEXT,
          metadata: { content, type, saved_at: new Date().toISOString() },
        });
        this.graph.addNode(node);
      }

      return {
        success: true,
        output: `Remembered: "${label}" = ${content.slice(0, 120)}${content.length > 120 ? '…' : ''}`,
        duration_ms: Date.now() - start,
      };
    } catch (err) {
      return {
        success: false,
        output: `Memory write failed: ${err instanceof Error ? err.message : String(err)}`,
        duration_ms: Date.now() - start,
      };
    }
  }
}
