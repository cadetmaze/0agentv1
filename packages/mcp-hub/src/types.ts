export interface MCPServerConfig {
  name: string;
  command?: string;       // for stdio transport
  args?: string[];
  url?: string;           // for SSE/HTTP transport
  env?: Record<string, string>;
  enabled: boolean;
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  server_name: string;
}

export interface MCPCallResult {
  content: Array<{
    type: 'text' | 'image';
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
}

export interface MCPConnection {
  config: MCPServerConfig;
  tools: MCPTool[];
  connected: boolean;
  error?: string;
}
