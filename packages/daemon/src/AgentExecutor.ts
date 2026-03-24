/**
 * AgentExecutor — the real agent loop.
 *
 * Takes a task, runs it through LLM tool-calling, actually executes
 * shell commands and file operations, streams tokens back, and returns
 * a structured result.
 *
 * Loop:
 *   1. LLM receives task + available tools
 *   2. LLM emits tool_calls (write_file, shell_exec, etc.)
 *   3. We execute the tools for real
 *   4. Results fed back to LLM
 *   5. Repeat until LLM returns end_turn (no more tool calls)
 *   6. Stream final response token by token
 */

import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import type { LLMExecutor, LLMMessage, LLMResponse } from './LLMExecutor.js';
import { CapabilityRegistry } from './capabilities/index.js';

export interface AgentResult {
  output: string;
  files_written: string[];
  commands_run: string[];
  tokens_used: number;
  model: string;
  iterations: number;
}

export interface AgentExecutorConfig {
  cwd: string;
  max_iterations?: number;
  max_command_ms?: number;
}

export class AgentExecutor {
  private cwd: string;
  private maxIterations: number;
  private maxCommandMs: number;
  private registry: CapabilityRegistry;

  constructor(
    private llm: LLMExecutor,
    private config: AgentExecutorConfig,
    private onStep: (step: string) => void,
    private onToken: (token: string) => void,
  ) {
    this.cwd = config.cwd;
    this.maxIterations = config.max_iterations ?? 20;
    this.maxCommandMs = config.max_command_ms ?? 30_000;
    this.registry = new CapabilityRegistry();
  }

  async execute(task: string, systemContext?: string): Promise<AgentResult> {
    const filesWritten: string[] = [];
    const commandsRun: string[] = [];
    let totalTokens = 0;
    let modelName = '';

    const systemPrompt = this.buildSystemPrompt(systemContext);
    const messages: LLMMessage[] = [
      { role: 'user', content: task },
    ];

    let finalOutput = '';

    for (let i = 0; i < this.maxIterations; i++) {
      this.onStep(i === 0 ? 'Thinking…' : 'Continuing…');

      let response: LLMResponse;
      try {
        response = await this.llm.completeWithTools(
          messages,
          this.registry.getToolDefinitions(),
          systemPrompt,
          // Only stream tokens on the final (non-tool) turn
          (token) => {
            this.onToken(token);
            finalOutput += token;
          },
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.onStep(`LLM error: ${msg}`);
        finalOutput = `Error: ${msg}`;
        break;
      }

      totalTokens += response.tokens_used;
      modelName = response.model;

      // No tool calls → we're done
      if (response.stop_reason === 'end_turn' || !response.tool_calls?.length) {
        if (!finalOutput && response.content) finalOutput = response.content;
        break;
      }

      // Reset streaming accumulator — this turn had tool calls, not final output
      finalOutput = '';

      // Append assistant message with tool calls
      messages.push({
        role: 'assistant',
        content: response.content,
        tool_calls: response.tool_calls,
      });

      // Execute each tool call
      for (const tc of response.tool_calls) {
        this.onStep(`▶ ${tc.name}(${this.summariseInput(tc.name, tc.input)})`);

        let result: string;
        try {
          const capResult = await this.registry.execute(tc.name, tc.input, this.cwd);
          result = capResult.output;
          if (capResult.fallback_used) {
            this.onStep(`  (used fallback: ${capResult.fallback_used})`);
          }
          // Track artifacts
          if (tc.name === 'file_op' && tc.input.op === 'write' && tc.input.path) {
            filesWritten.push(String(tc.input.path));
          }
          if (tc.name === 'shell_exec' && tc.input.command) {
            commandsRun.push(String(tc.input.command));
          }
        } catch (err) {
          result = `Error: ${err instanceof Error ? err.message : String(err)}`;
        }

        this.onStep(`  ↳ ${result.slice(0, 120)}${result.length > 120 ? '…' : ''}`);

        messages.push({
          role: 'tool',
          content: result,
          tool_call_id: tc.id,
        });
      }
    }

    return {
      output: finalOutput || '(no output)',
      files_written: filesWritten,
      commands_run: commandsRun,
      tokens_used: totalTokens,
      model: modelName,
      iterations: messages.filter(m => m.role === 'assistant').length,
    };
  }

  // ─── Tool execution ────────────────────────────────────────────────────────

  private async executeTool(name: string, input: Record<string, unknown>): Promise<string> {
    switch (name) {
      case 'shell_exec':
        return this.shellExec(
          String(input.command ?? ''),
          Number(input.timeout_ms ?? this.maxCommandMs),
        );
      case 'write_file':
        return this.writeFile(String(input.path ?? ''), String(input.content ?? ''));
      case 'read_file':
        return this.readFile(String(input.path ?? ''));
      case 'list_dir':
        return this.listDir(input.path ? String(input.path) : undefined);
      case 'web_search':
        return this.webSearch(
          String(input.query ?? ''),
          Math.min(10, Number(input.num_results ?? 5)),
        );
      case 'scrape_url':
        return this.scrapeUrl(
          String(input.url ?? ''),
          String(input.mode ?? 'text'),
          input.selector ? String(input.selector) : undefined,
          Number(input.wait_ms ?? 0),
        );
      default:
        return `Unknown tool: ${name}`;
    }
  }

  private shellExec(command: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve) => {
      const chunks: string[] = [];
      const proc = spawn('bash', ['-c', command], {
        cwd: this.cwd,
        env: { ...process.env, TERM: 'dumb' },
        timeout: timeoutMs,
      });

      proc.stdout.on('data', (d: Buffer) => chunks.push(d.toString()));
      proc.stderr.on('data', (d: Buffer) => chunks.push(d.toString()));

      proc.on('close', (code) => {
        const output = chunks.join('').trim();
        resolve(output || (code === 0 ? '(command completed, no output)' : `exit code ${code}`));
      });

      proc.on('error', (err) => {
        resolve(`Error: ${err.message}`);
      });
    });
  }

  private writeFile(filePath: string, content: string): string {
    const safe = this.safePath(filePath);
    if (!safe) return 'Error: path outside working directory';
    mkdirSync(dirname(safe), { recursive: true });
    writeFileSync(safe, content, 'utf8');
    const rel = relative(this.cwd, safe);
    return `Written: ${rel} (${content.length} bytes)`;
  }

  private readFile(filePath: string): string {
    const safe = this.safePath(filePath);
    if (!safe) return 'Error: path outside working directory';
    if (!existsSync(safe)) return `File not found: ${filePath}`;
    const content = readFileSync(safe, 'utf8');
    // Truncate large files
    return content.length > 8000
      ? content.slice(0, 8000) + `\n…[truncated, ${content.length} total bytes]`
      : content;
  }

  private async webSearch(query: string, numResults: number): Promise<string> {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=us-en`;
    let html = '';
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: AbortSignal.timeout(12_000),
      });
      html = await res.text();
    } catch (err) {
      return `Search request failed: ${err instanceof Error ? err.message : String(err)}`;
    }

    // Parse DDG HTML results — titles + redirect URLs + snippets
    const results: Array<{ title: string; url: string; snippet: string }> = [];

    // Title links: <a class="result__a" href="...">Title</a>
    const titleRe = /<a[^>]+class="result__a"[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
    const snippetRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

    const titles: Array<{ url: string; title: string }> = [];
    const snippets: string[] = [];

    let m: RegExpExecArray | null;
    while ((m = titleRe.exec(html)) !== null) {
      let href = m[1];
      const title = m[2].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
      // Decode DDG redirect: /l/?uddg=ENCODED_URL
      const uddg = href.match(/[?&]uddg=([^&]+)/);
      if (uddg) href = decodeURIComponent(uddg[1]);
      if (href.startsWith('http') && title && titles.length < numResults) {
        titles.push({ url: href, title });
      }
    }

    while ((m = snippetRe.exec(html)) !== null && snippets.length < numResults) {
      snippets.push(m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
    }

    if (titles.length === 0) {
      // Last resort: return plain-text snippet of the page
      const plainText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 1500);
      return `No results parsed. Raw content:\n${plainText}`;
    }

    return titles.map((t, i) =>
      `${i + 1}. ${t.title}\n   URL: ${t.url}${snippets[i] ? `\n   ${snippets[i]}` : ''}`
    ).join('\n\n');
  }

  private async scrapeUrl(url: string, mode: string, selector?: string, waitMs?: number): Promise<string> {
    if (!url.startsWith('http')) return 'Error: URL must start with http:// or https://';

    // Build a Python script using Scrapling (auto-installs if missing)
    const selectorLine = selector ? `element = page.find('${selector}')\ncontent = element.text if element else page.get_all_text()` : `content = page.get_all_text()`;
    const modeLine = mode === 'links'
      ? `result = [a.attrib.get('href','') for a in page.find_all('a') if a.attrib.get('href','').startswith('http')]`
      : mode === 'tables'
      ? `result = [str(t) for t in page.find_all('table')]`
      : mode === 'markdown'
      ? `result = page.get_all_text()`
      : `result = page.get_all_text()`;

    const script = [
      `import sys`,
      `try:`,
      `    from scrapling import Fetcher`,
      `except ImportError:`,
      `    import subprocess, sys`,
      `    subprocess.run([sys.executable, '-m', 'pip', 'install', 'scrapling', '-q'], check=True)`,
      `    from scrapling import Fetcher`,
      `try:`,
      `    fetcher = Fetcher(auto_match=False)`,
      `    page = fetcher.get('${url}', timeout=20)`,
      `    ${modeLine}`,
      `    if isinstance(result, list):`,
      `        print('\\n'.join(str(r) for r in result[:50]))`,
      `    else:`,
      `        text = str(result).strip()`,
      `        print(text[:6000] + ('...[truncated]' if len(text)>6000 else ''))`,
      `except Exception as e:`,
      `    # Fallback to simple fetch if scrapling fails`,
      `    import urllib.request`,
      `    try:`,
      `        req = urllib.request.Request('${url}', headers={'User-Agent': 'Mozilla/5.0'})`,
      `        with urllib.request.urlopen(req, timeout=15) as resp:`,
      `            body = resp.read().decode('utf-8', errors='ignore')`,
      `            # Strip tags simply`,
      `            import re`,
      `            text = re.sub(r'<[^>]+>', ' ', body)`,
      `            text = re.sub(r'\\s+', ' ', text).strip()`,
      `            print(text[:5000])`,
      `    except Exception as e2:`,
      `        print(f'Scrape failed: {e} / {e2}', file=sys.stderr)`,
    ].join('\n');

    return this.shellExec(`python3 -c "${script.replace(/"/g, '\\"').replace(/\n/g, ';')}"`, 30_000);
  }

  private listDir(dirPath?: string): string {
    const safe = this.safePath(dirPath ?? '.');
    if (!safe) return 'Error: path outside working directory';
    if (!existsSync(safe)) return `Directory not found: ${dirPath}`;
    try {
      const entries = readdirSync(safe, { withFileTypes: true })
        .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules')
        .map(e => `${e.isDirectory() ? 'd' : 'f'}  ${e.name}`)
        .join('\n');
      return entries || '(empty directory)';
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private safePath(p: string): string | null {
    const resolved = resolve(this.cwd, p);
    return resolved.startsWith(this.cwd) ? resolved : null;
  }

  private buildSystemPrompt(extra?: string): string {
    const lines = [
      `You are 0agent, an AI software engineer. You can execute shell commands and manage files.`,
      `Working directory: ${this.cwd}`,
      ``,
      `Instructions:`,
      `- Use tools to actually accomplish tasks, don't just describe what to do`,
      `- For web servers: write the files, then start the server with & (background)`,
      `- For npm/node projects: check package.json first with read_file or list_dir`,
      `- After write_file, verify with read_file if needed`,
      `- After shell_exec, check output for errors and retry if needed`,
      `- For research tasks: use web_search first, then scrape_url for full page content`,
    `- Use relative paths from the working directory`,
      `- Be concise in your final response: state what was done and where to find it`,
    ];
    if (extra) lines.push(``, `Context:`, extra);
    return lines.join('\n');
  }

  private summariseInput(toolName: string, input: Record<string, unknown>): string {
    if (toolName === 'shell_exec')  return `"${String(input.command ?? '').slice(0, 60)}"`;
    if (toolName === 'write_file')  return `"${input.path}"`;
    if (toolName === 'read_file')   return `"${input.path}"`;
    if (toolName === 'list_dir')    return `"${input.path ?? '.'}"`;
    if (toolName === 'web_search')  return `"${String(input.query ?? '').slice(0, 60)}"`;
    if (toolName === 'scrape_url')  return `"${String(input.url ?? '').slice(0, 60)}" mode=${input.mode ?? 'text'}`;
    return JSON.stringify(input).slice(0, 60);
  }
}
