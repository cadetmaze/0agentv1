import type { Capability, CapabilityResult, ToolDefinition } from './types.js';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

export class FileCapability implements Capability {
  readonly name = 'file_op';
  readonly description = 'Read, write, list files, or create directories. Scoped to working directory.';

  readonly toolDefinition: ToolDefinition = {
    name: 'file_op',
    description: 'Read, write, list files, or create directories in the working directory.',
    input_schema: {
      type: 'object',
      properties: {
        op:      { type: 'string', description: '"read", "write", "list", or "mkdir"' },
        path:    { type: 'string', description: 'File or directory path (relative to cwd)' },
        content: { type: 'string', description: 'Content for write operation' },
      },
      required: ['op', 'path'],
    },
  };

  async execute(input: Record<string, unknown>, cwd: string): Promise<CapabilityResult> {
    const op = String(input.op ?? 'read');
    const rel = String(input.path ?? '.');
    const safe = resolve(cwd, rel);
    const start = Date.now();

    if (!safe.startsWith(cwd)) {
      return { success: false, output: 'Path outside working directory', duration_ms: 0 };
    }

    try {
      if (op === 'read') {
        if (!existsSync(safe)) return { success: false, output: `Not found: ${rel}`, duration_ms: Date.now() - start };
        const content = readFileSync(safe, 'utf8');
        return {
          success: true,
          output: content.length > 8000 ? content.slice(0, 8000) + '\n…[truncated]' : content,
          duration_ms: Date.now() - start,
        };
      }

      if (op === 'write') {
        mkdirSync(dirname(safe), { recursive: true });
        writeFileSync(safe, String(input.content ?? ''), 'utf8');
        return { success: true, output: `Written: ${rel} (${String(input.content ?? '').length} bytes)`, duration_ms: Date.now() - start };
      }

      if (op === 'list') {
        if (!existsSync(safe)) return { success: false, output: `Not found: ${rel}`, duration_ms: Date.now() - start };
        const entries = readdirSync(safe, { withFileTypes: true })
          .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules')
          .map(e => `${e.isDirectory() ? 'd' : 'f'}  ${e.name}`)
          .join('\n');
        return { success: true, output: entries || '(empty)', duration_ms: Date.now() - start };
      }

      if (op === 'mkdir') {
        mkdirSync(safe, { recursive: true });
        return { success: true, output: `Directory created: ${rel}`, duration_ms: Date.now() - start };
      }

      return { success: false, output: `Unknown op: ${op}. Use "read", "write", "list", or "mkdir"`, duration_ms: Date.now() - start };
    } catch (err) {
      return { success: false, output: `Error: ${err instanceof Error ? err.message : String(err)}`, duration_ms: Date.now() - start };
    }
  }
}
