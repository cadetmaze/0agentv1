import type { Capability, CapabilityResult, ToolDefinition } from './types.js';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

export class FileCapability implements Capability {
  readonly name = 'file_op';
  readonly description = 'Read, write, list files, or create directories. Scoped to working directory.';

  readonly toolDefinition: ToolDefinition = {
    name: 'file_op',
    description: 'Read, write, edit, list files, or create directories. Use "edit" for surgical find-and-replace changes (preferred over rewriting entire files).',
    input_schema: {
      type: 'object',
      properties: {
        op:       { type: 'string', description: '"read", "write", "edit", "list", or "mkdir"' },
        path:     { type: 'string', description: 'File or directory path (relative to cwd)' },
        content:  { type: 'string', description: 'Content for write operation' },
        old_text: { type: 'string', description: 'Exact text to find for edit operation (must appear exactly once in the file)' },
        new_text: { type: 'string', description: 'Replacement text for edit operation' },
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

      if (op === 'edit') {
        const oldText = String(input.old_text ?? '');
        const newText = String(input.new_text ?? '');
        if (!oldText) return { success: false, output: 'old_text is required for edit', duration_ms: 0 };
        if (!existsSync(safe)) return { success: false, output: `Not found: ${rel}`, duration_ms: Date.now() - start };

        const content = readFileSync(safe, 'utf8');
        // Normalize line endings for comparison
        const normContent = content.replace(/\r\n/g, '\n');
        const normOld = oldText.replace(/\r\n/g, '\n');

        // Count occurrences
        let count = 0;
        let searchIdx = 0;
        while ((searchIdx = normContent.indexOf(normOld, searchIdx)) !== -1) {
          count++;
          searchIdx += normOld.length;
        }

        if (count === 0) return { success: false, output: `old_text not found in ${rel}`, duration_ms: Date.now() - start };
        if (count > 1) return { success: false, output: `old_text is ambiguous — appears ${count} times in ${rel}. Include more surrounding context.`, duration_ms: Date.now() - start };

        // Replace in normalized content, restore original line ending style
        const normNew = newText.replace(/\r\n/g, '\n');
        let newContent = normContent.replace(normOld, normNew);
        if (content.includes('\r\n')) newContent = newContent.replace(/\n/g, '\r\n');

        writeFileSync(safe, newContent, 'utf8');
        const oldLines = normOld.split('\n').length;
        const newLines = normNew.split('\n').length;
        return { success: true, output: `Edited ${rel}: replaced ${oldLines} line(s) with ${newLines} line(s)`, duration_ms: Date.now() - start };
      }

      if (op === 'mkdir') {
        mkdirSync(safe, { recursive: true });
        return { success: true, output: `Directory created: ${rel}`, duration_ms: Date.now() - start };
      }

      return { success: false, output: `Unknown op: ${op}. Use "read", "write", "edit", "list", or "mkdir"`, duration_ms: Date.now() - start };
    } catch (err) {
      return { success: false, output: `Error: ${err instanceof Error ? err.message : String(err)}`, duration_ms: Date.now() - start };
    }
  }
}
