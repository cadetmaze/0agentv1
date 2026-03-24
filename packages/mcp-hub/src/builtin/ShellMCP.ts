import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { MCPTool, MCPCallResult } from '../types.js';

const DANGEROUS_PATTERNS = [
  /rm\s+(-\w+\s+)*-rf\s+\//,
  /rm\s+(-\w+\s+)*\/\s/,
  /mkfs\./,
  /dd\s+if=/,
  /:\(\)\s*\{\s*:\|:\s*&\s*\}/,  // fork bomb
  />\s*\/dev\/sd/,
  /chmod\s+(-\w+\s+)*777\s+\//,
  /curl\s+.*\|\s*(ba)?sh/,
  /wget\s+.*\|\s*(ba)?sh/,
];

export class ShellMCP {
  private scopePath: string;

  constructor(scope: string) {
    this.scopePath = resolve(scope);
  }

  get tools(): MCPTool[] {
    return [
      {
        name: 'execute_command',
        description: 'Execute a shell command within the scoped directory',
        inputSchema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The shell command to execute' },
            timeout: { type: 'number', description: 'Timeout in milliseconds (default 30000)' },
          },
          required: ['command'],
        },
        server_name: 'shell',
      },
    ];
  }

  async call(toolName: string, args: Record<string, unknown>): Promise<MCPCallResult> {
    if (toolName !== 'execute_command') {
      return { content: [{ type: 'text', text: `Unknown tool: ${toolName}` }], isError: true };
    }

    const command = args.command as string;
    if (!command || typeof command !== 'string') {
      return { content: [{ type: 'text', text: 'Missing or invalid command' }], isError: true };
    }

    // Reject dangerous commands
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(command)) {
        return {
          content: [{ type: 'text', text: `Command rejected: matches dangerous pattern` }],
          isError: true,
        };
      }
    }

    const timeout = typeof args.timeout === 'number' ? args.timeout : 30_000;

    try {
      const stdout = execSync(command, {
        cwd: this.scopePath,
        timeout,
        maxBuffer: 1024 * 1024, // 1 MB
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { content: [{ type: 'text', text: stdout }] };
    } catch (err: unknown) {
      const error = err as { stderr?: string; message?: string; status?: number };
      const stderr = error.stderr ?? error.message ?? 'Command failed';
      return {
        content: [{ type: 'text', text: `Exit code ${error.status ?? 1}\n${stderr}` }],
        isError: true,
      };
    }
  }
}
