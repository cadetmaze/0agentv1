import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import type { MCPTool, MCPCallResult } from '../types.js';

export class FilesystemMCP {
  private scopePath: string;

  constructor(scope: string) {
    this.scopePath = resolve(scope);
  }

  get tools(): MCPTool[] {
    return [
      {
        name: 'read_file',
        description: 'Read file contents',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        server_name: 'filesystem',
      },
      {
        name: 'write_file',
        description: 'Write file contents',
        inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
        server_name: 'filesystem',
      },
      {
        name: 'list_directory',
        description: 'List directory contents',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        server_name: 'filesystem',
      },
      {
        name: 'search_files',
        description: 'Search for files by name pattern',
        inputSchema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] },
        server_name: 'filesystem',
      },
    ];
  }

  /** Resolve and validate path is within scope. */
  private resolveSafe(filePath: string): string | null {
    const resolved = resolve(this.scopePath, filePath);
    if (!resolved.startsWith(this.scopePath)) return null;
    return resolved;
  }

  async call(toolName: string, args: Record<string, unknown>): Promise<MCPCallResult> {
    switch (toolName) {
      case 'read_file': {
        const safePath = this.resolveSafe(args.path as string);
        if (!safePath) return { content: [{ type: 'text', text: 'Path outside scope' }], isError: true };
        if (!existsSync(safePath)) return { content: [{ type: 'text', text: 'File not found' }], isError: true };
        const content = readFileSync(safePath, 'utf8');
        return { content: [{ type: 'text', text: content }] };
      }
      case 'write_file': {
        const safePath = this.resolveSafe(args.path as string);
        if (!safePath) return { content: [{ type: 'text', text: 'Path outside scope' }], isError: true };
        writeFileSync(safePath, args.content as string, 'utf8');
        return { content: [{ type: 'text', text: `Written: ${args.path}` }] };
      }
      case 'list_directory': {
        const safePath = this.resolveSafe(args.path as string);
        if (!safePath) return { content: [{ type: 'text', text: 'Path outside scope' }], isError: true };
        if (!existsSync(safePath)) return { content: [{ type: 'text', text: 'Directory not found' }], isError: true };
        const entries = readdirSync(safePath, { withFileTypes: true });
        const listing = entries.map(e => `${e.isDirectory() ? 'd' : 'f'} ${e.name}`).join('\n');
        return { content: [{ type: 'text', text: listing }] };
      }
      case 'search_files': {
        const pattern = args.pattern as string;
        const searchPath = this.resolveSafe((args.path as string) ?? '.') ?? this.scopePath;
        const matches = this.searchRecursive(searchPath, new RegExp(pattern, 'i'));
        return { content: [{ type: 'text', text: matches.join('\n') || 'No matches' }] };
      }
      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${toolName}` }], isError: true };
    }
  }

  private searchRecursive(dir: string, pattern: RegExp, results: string[] = [], depth: number = 0): string[] {
    if (depth > 5) return results;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const fullPath = join(dir, entry.name);
        if (pattern.test(entry.name)) {
          results.push(relative(this.scopePath, fullPath));
        }
        if (entry.isDirectory()) {
          this.searchRecursive(fullPath, pattern, results, depth + 1);
        }
      }
    } catch {
      /* permission errors etc */
    }
    return results;
  }
}
