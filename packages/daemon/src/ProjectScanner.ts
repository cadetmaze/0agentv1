import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';

export interface ProjectContext {
  cwd: string;
  stack: string[];            // ['typescript', 'react', 'node']
  name: string;               // project name from package.json
  recent_commits: string[];   // last 5 commit messages
  dirty_files: string[];      // uncommitted changes
  running_ports: number[];    // detected open ports
  readme_summary: string;     // first 300 chars of README
}

const PORTS_TO_CHECK = [3000, 3001, 4000, 4200, 5000, 5173, 8000, 8080, 8888];

export class ProjectScanner {
  constructor(private cwd: string) {}

  async scan(): Promise<ProjectContext> {
    const [stack, name] = this.detectStack();
    const recentCommits = this.getRecentCommits();
    const dirtyFiles = this.getDirtyFiles();
    const runningPorts = await this.getRunningPorts();
    const readmeSummary = this.getReadmeSummary();

    return {
      cwd: this.cwd,
      stack,
      name,
      recent_commits: recentCommits,
      dirty_files: dirtyFiles,
      running_ports: runningPorts,
      readme_summary: readmeSummary,
    };
  }

  /**
   * Build a compact system prompt injection from the context.
   */
  static buildContextPrompt(ctx: ProjectContext): string {
    const lines: string[] = [`Working directory: ${ctx.cwd}`];

    if (ctx.name) lines.push(`Project: ${ctx.name}`);
    if (ctx.stack.length) lines.push(`Stack: ${ctx.stack.join(', ')}`);
    if (ctx.recent_commits.length) {
      lines.push(`Recent commits: ${ctx.recent_commits.slice(0, 3).join(' | ')}`);
    }
    if (ctx.dirty_files.length) {
      lines.push(`Uncommitted changes: ${ctx.dirty_files.slice(0, 5).join(', ')}`);
    }
    if (ctx.running_ports.length) {
      lines.push(`Running servers: ports ${ctx.running_ports.join(', ')}`);
    }
    if (ctx.readme_summary) {
      lines.push(`README: ${ctx.readme_summary}`);
    }

    return lines.join('\n');
  }

  private detectStack(): [string[], string] {
    const stack: string[] = [];
    let name = '';

    // package.json → Node/TypeScript/React/etc.
    const pkgPath = join(this.cwd, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
        name = pkg.name ?? '';
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        stack.push('node');
        if (deps.typescript || existsSync(join(this.cwd, 'tsconfig.json'))) stack.push('typescript');
        if (deps.react) stack.push('react');
        if (deps.vue) stack.push('vue');
        if (deps.svelte) stack.push('svelte');
        if (deps.next) stack.push('next.js');
        if (deps.express || deps.fastify || deps.hono) stack.push('backend');
      } catch {}
    }

    // Cargo.toml → Rust
    if (existsSync(join(this.cwd, 'Cargo.toml'))) {
      stack.push('rust');
      try {
        const cargo = readFileSync(join(this.cwd, 'Cargo.toml'), 'utf8');
        const nameMatch = cargo.match(/^name\s*=\s*"([^"]+)"/m);
        if (nameMatch && !name) name = nameMatch[1];
      } catch {}
    }

    // pyproject.toml / requirements.txt → Python
    if (existsSync(join(this.cwd, 'pyproject.toml')) || existsSync(join(this.cwd, 'requirements.txt'))) {
      stack.push('python');
    }

    // go.mod → Go
    if (existsSync(join(this.cwd, 'go.mod'))) stack.push('go');

    return [stack, name];
  }

  private getRecentCommits(): string[] {
    try {
      const out = execSync('git log --oneline -5 2>/dev/null', {
        cwd: this.cwd, timeout: 3000, encoding: 'utf8',
      }).trim();
      return out ? out.split('\n').map(l => l.trim()) : [];
    } catch { return []; }
  }

  private getDirtyFiles(): string[] {
    try {
      const out = execSync('git status --short 2>/dev/null', {
        cwd: this.cwd, timeout: 3000, encoding: 'utf8',
      }).trim();
      return out ? out.split('\n').map(l => l.slice(3).trim()) : [];
    } catch { return []; }
  }

  private async getRunningPorts(): Promise<number[]> {
    const open: number[] = [];
    await Promise.all(PORTS_TO_CHECK.map(port =>
      new Promise<void>(resolve => {
        const s = createServer();
        s.listen(port, '127.0.0.1', () => { s.close(); resolve(); });
        s.on('error', () => { open.push(port); resolve(); });
        setTimeout(() => { s.close(); resolve(); }, 200);
      })
    ));
    return open;
  }

  private getReadmeSummary(): string {
    for (const name of ['README.md', 'readme.md', 'README.txt', 'README']) {
      const p = join(this.cwd, name);
      if (existsSync(p)) {
        try {
          return readFileSync(p, 'utf8').slice(0, 300).replace(/\n+/g, ' ').trim();
        } catch {}
      }
    }
    return '';
  }
}
