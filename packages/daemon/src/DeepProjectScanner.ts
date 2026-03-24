import { execSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ProjectScanner, type ProjectContext } from './ProjectScanner.js';

export interface TodoItem { file: string; line: number; text: string; type: 'TODO' | 'FIXME' | 'HACK' | 'XXX'; }
export interface FileTreeNode { name: string; type: 'file' | 'dir'; children?: FileTreeNode[]; }
export interface HotFile { path: string; commits: number; }

export interface DeepProjectContext extends ProjectContext {
  open_todos: TodoItem[];
  file_structure: FileTreeNode[];
  hot_files: HotFile[];
  scanned_at: number;
}

export class DeepProjectScanner extends ProjectScanner {
  private cachedDeepContext: DeepProjectContext | null = null;
  private cacheExpiresAt = 0;
  private static readonly CACHE_TTL_MS = 5 * 60 * 1000;

  async deepScan(): Promise<DeepProjectContext> {
    // Return cached if valid
    if (this.cachedDeepContext && Date.now() < this.cacheExpiresAt) {
      return this.cachedDeepContext;
    }

    // Get base context
    const base = await this.scan();

    // Parallel: todos, tree, hot files
    const [openTodos, fileStructure, hotFiles] = await Promise.all([
      this.scanTodos(),
      Promise.resolve(this.buildFileTree(this['cwd'], 0, 2)),
      this.getHotFiles(),
    ]);

    const deep: DeepProjectContext = { ...base, open_todos: openTodos, file_structure: fileStructure, hot_files: hotFiles, scanned_at: Date.now() };
    this.cachedDeepContext = deep;
    this.cacheExpiresAt = Date.now() + DeepProjectScanner.CACHE_TTL_MS;
    return deep;
  }

  /**
   * Build a system prompt from deep context (more detailed than ProjectScanner).
   */
  static buildDeepContextPrompt(ctx: DeepProjectContext): string {
    const lines: string[] = [ProjectScanner.buildContextPrompt(ctx)];
    if (ctx.open_todos.length > 0) {
      lines.push(`Open TODOs: ${ctx.open_todos.slice(0, 5).map(t => `${t.file}:${t.line} — ${t.text}`).join(' | ')}`);
    }
    if (ctx.hot_files.length > 0) {
      lines.push(`Hottest files (most commits): ${ctx.hot_files.slice(0, 3).map(f => f.path).join(', ')}`);
    }
    return lines.join('\n');
  }

  private async scanTodos(): Promise<TodoItem[]> {
    const todos: TodoItem[] = [];
    try {
      const output = execSync(
        `grep -rn "TODO\\|FIXME\\|HACK\\|XXX" --include="*.ts" --include="*.js" --include="*.py" --include="*.rs" --include="*.go" .`,
        { cwd: this['cwd'], timeout: 5000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
      );
      for (const line of output.split('\n').slice(0, 30)) {
        const m = line.match(/^([^:]+):(\d+):[^:]*?(TODO|FIXME|HACK|XXX)[:\s](.*)$/);
        if (m) todos.push({ file: m[1], line: parseInt(m[2], 10), type: m[3] as TodoItem['type'], text: m[4].trim().slice(0, 100) });
      }
    } catch {}
    return todos;
  }

  private buildFileTree(dir: string, depth: number, maxDepth: number): FileTreeNode[] {
    if (depth > maxDepth) return [];
    const SKIP = new Set(['node_modules', '.git', 'dist', '.turbo', 'coverage', '.next', 'target']);
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter(e => !e.name.startsWith('.') && !SKIP.has(e.name))
        .slice(0, 20)
        .map(e => ({
          name: e.name,
          type: e.isDirectory() ? 'dir' as const : 'file' as const,
          ...(e.isDirectory() ? { children: this.buildFileTree(join(dir, e.name), depth + 1, maxDepth) } : {}),
        }));
    } catch { return []; }
  }

  private async getHotFiles(): Promise<HotFile[]> {
    try {
      const output = execSync(
        `git log --since="30 days ago" --name-only --pretty=format: .`,
        { cwd: this['cwd'], timeout: 3000, encoding: 'utf8' }
      );
      const counts = new Map<string, number>();
      for (const line of output.split('\n')) {
        const f = line.trim();
        if (f && !f.startsWith('.')) counts.set(f, (counts.get(f) ?? 0) + 1);
      }
      return [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([path, commits]) => ({ path, commits }));
    } catch { return []; }
  }
}
