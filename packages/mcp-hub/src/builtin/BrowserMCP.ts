import type { MCPTool, MCPCallResult } from '../types.js';

const STUB_RESULT: MCPCallResult = {
  content: [{ type: 'text', text: 'Browser not available — install sandbox (Phase 3)' }],
  isError: true,
};

export class BrowserMCP {
  get tools(): MCPTool[] {
    return [
      {
        name: 'browser_navigate',
        description: 'Navigate to a URL',
        inputSchema: {
          type: 'object',
          properties: { url: { type: 'string' } },
          required: ['url'],
        },
        server_name: 'browser',
      },
      {
        name: 'browser_snapshot',
        description: 'Get accessibility snapshot of current page',
        inputSchema: { type: 'object', properties: {} },
        server_name: 'browser',
      },
      {
        name: 'browser_click',
        description: 'Click an element on the page',
        inputSchema: {
          type: 'object',
          properties: { selector: { type: 'string' } },
          required: ['selector'],
        },
        server_name: 'browser',
      },
      {
        name: 'browser_fill',
        description: 'Fill an input field',
        inputSchema: {
          type: 'object',
          properties: {
            selector: { type: 'string' },
            value: { type: 'string' },
          },
          required: ['selector', 'value'],
        },
        server_name: 'browser',
      },
      {
        name: 'browser_screenshot',
        description: 'Take a screenshot of the page',
        inputSchema: { type: 'object', properties: {} },
        server_name: 'browser',
      },
      {
        name: 'browser_extract',
        description: 'Extract structured data from the page',
        inputSchema: {
          type: 'object',
          properties: { selector: { type: 'string' } },
          required: ['selector'],
        },
        server_name: 'browser',
      },
    ];
  }

  async call(_toolName: string, _args: Record<string, unknown>): Promise<MCPCallResult> {
    return STUB_RESULT;
  }
}
