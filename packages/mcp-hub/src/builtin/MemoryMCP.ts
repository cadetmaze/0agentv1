import {
  type KnowledgeGraph,
  type GraphNode,
  NodeType,
  ContentType,
  createNode,
} from "@0agent/core";
import type { MCPTool, MCPCallResult } from "../types.js";

export class MemoryMCP {
  constructor(private graph: KnowledgeGraph) {}

  get tools(): MCPTool[] {
    return [
      {
        name: "query_graph",
        description: "Run a structural query against the knowledge graph",
        inputSchema: {
          type: "object",
          properties: {
            node_type: { type: "string", description: "Filter by node type" },
            graph_id: { type: "string", description: "Filter by graph ID" },
            limit: { type: "number", description: "Max results to return" },
          },
        },
        server_name: "memory",
      },
      {
        name: "get_entity",
        description: "Get a node and its surrounding subgraph",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Node ID" },
            depth: {
              type: "number",
              description: "Subgraph traversal depth (default 2)",
            },
          },
          required: ["id"],
        },
        server_name: "memory",
      },
      {
        name: "search_nodes",
        description: "Semantic search across graph nodes",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Natural language search query",
            },
            limit: { type: "number", description: "Max results" },
          },
          required: ["query"],
        },
        server_name: "memory",
      },
      {
        name: "add_observation",
        description: "Add a new observation node to the graph",
        inputSchema: {
          type: "object",
          properties: {
            label: { type: "string", description: "Node label" },
            content: {
              type: "string",
              description: "Text content / observation body",
            },
            graph_id: { type: "string", description: "Graph ID to add to" },
          },
          required: ["label", "content"],
        },
        server_name: "memory",
      },
    ];
  }

  async call(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<MCPCallResult> {
    try {
      switch (toolName) {
        case "query_graph": {
          const results = this.graph.queryStructural({
            node_type: args.node_type as NodeType | undefined,
            graph_id: args.graph_id as string | undefined,
            limit: (args.limit as number) ?? 20,
          });
          const simplified = results.map((r) => ({
            id: r.node.id,
            label: r.node.label,
            type: r.node.type,
            score: r.score,
          }));
          return {
            content: [
              { type: "text", text: JSON.stringify(simplified, null, 2) },
            ],
          };
        }

        case "get_entity": {
          const id = args.id as string;
          const depth = (args.depth as number) ?? 2;
          const node = this.graph.getNode(id);
          if (!node) {
            return {
              content: [{ type: "text", text: `Node '${id}' not found` }],
              isError: true,
            };
          }
          const subgraph = this.graph.getSubGraph(id, depth);
          const snapshot = subgraph.toSnapshot();
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    node: {
                      id: node.id,
                      label: node.label,
                      type: node.type,
                    },
                    subgraph: {
                      nodeCount: snapshot.nodes.length,
                      edgeCount: snapshot.edges.length,
                    },
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        case "search_nodes": {
          // Semantic search requires an embedding — stub returns empty
          // Full implementation requires MultimodalEmbedder (Phase 4)
          return {
            content: [
              {
                type: "text",
                text: "Semantic search requires embedding model — configure in settings",
              },
            ],
            isError: true,
          };
        }

        case "add_observation": {
          const label = args.label as string;
          const content = args.content as string;
          const graphId = (args.graph_id as string) ?? "root";
          const node = createNode({
            id: crypto.randomUUID(),
            graph_id: graphId,
            label,
            type: NodeType.SIGNAL,
            content: [
              {
                id: crypto.randomUUID(),
                node_id: "",
                type: ContentType.TEXT,
                data: content,
                metadata: {},
              },
            ],
          });
          node.content[0].node_id = node.id;
          this.graph.addNode(node);
          return {
            content: [
              { type: "text", text: `Added observation: ${node.id}` },
            ],
          };
        }

        default:
          return {
            content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
            isError: true,
          };
      }
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }
}
