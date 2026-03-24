import type { Capability, CapabilityResult, ToolDefinition } from './types.js';
import { execSync, spawnSync } from 'node:child_process';

export class WebSearchCapability implements Capability {
  readonly name = 'web_search';
  readonly description = 'Search the web. Returns titles, URLs, and snippets. No API key needed.';

  readonly toolDefinition: ToolDefinition = {
    name: 'web_search',
    description: 'Search the web and return titles, URLs, and snippets. No API key needed. Use first to find pages, then scrape_url for full content.',
    input_schema: {
      type: 'object',
      properties: {
        query:       { type: 'string', description: 'Search query' },
        num_results: { type: 'number', description: 'Number of results (default 5, max 10)' },
      },
      required: ['query'],
    },
  };

  async execute(input: Record<string, unknown>, _cwd: string): Promise<CapabilityResult> {
    const query = String(input.query ?? '');
    const n = Math.min(10, Number(input.num_results ?? 5));
    const start = Date.now();

    // Tier 1: DDG HTML (native fetch, zero deps)
    try {
      const output = await this.ddgHtml(query, n);
      if (output && output.length > 50) {
        return { success: true, output, duration_ms: Date.now() - start };
      }
    } catch {}

    // Tier 2: Browser fallback (Playwright or system Chrome)
    try {
      const output = await this.browserSearch(query, n);
      return { success: true, output, fallback_used: 'browser', duration_ms: Date.now() - start };
    } catch (err) {
      return {
        success: false,
        output: `Search failed: ${err instanceof Error ? err.message : String(err)}`,
        duration_ms: Date.now() - start,
      };
    }
  }

  private async ddgHtml(query: string, n: number): Promise<string> {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=us-en`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
        'Accept': 'text/html',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(10_000),
    });
    const html = await res.text();

    const titleRe = /<a[^>]+class="result__a"[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
    const snippetRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

    const titles: Array<{ url: string; title: string }> = [];
    const snippets: string[] = [];
    let m: RegExpExecArray | null;

    while ((m = titleRe.exec(html)) !== null && titles.length < n) {
      let href = m[1];
      const title = m[2].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim();
      const uddg = href.match(/[?&]uddg=([^&]+)/);
      if (uddg) href = decodeURIComponent(uddg[1]);
      if (href.startsWith('http') && title) titles.push({ url: href, title });
    }
    while ((m = snippetRe.exec(html)) !== null && snippets.length < n) {
      snippets.push(m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
    }

    if (titles.length === 0) throw new Error('No results parsed from DDG');

    return titles.map((t, i) =>
      `${i + 1}. ${t.title}\n   URL: ${t.url}${snippets[i] ? `\n   ${snippets[i]}` : ''}`
    ).join('\n\n');
  }

  private async browserSearch(query: string, n: number): Promise<string> {
    const searchUrl = `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;

    // Try Playwright if installed
    try {
      const result = spawnSync('node', ['-e', `
        const { chromium } = require('playwright');
        (async () => {
          const b = await chromium.launch({ headless: true });
          const p = await b.newPage();
          await p.goto('${searchUrl}', { timeout: 15000 });
          await p.waitForSelector('[data-result]', { timeout: 8000 }).catch(() => {});
          const results = await p.$$eval('[data-result]', els =>
            els.slice(0, ${n}).map(el => ({
              title: el.querySelector('h2')?.innerText ?? '',
              url: el.querySelector('a')?.href ?? '',
              snippet: el.querySelector('[data-result="snippet"]')?.innerText ?? ''
            }))
          );
          await b.close();
          console.log(JSON.stringify(results));
        })();
      `], { timeout: 25_000, encoding: 'utf8' });

      if (result.status === 0 && result.stdout) {
        const results = JSON.parse(result.stdout) as Array<{ title: string; url: string; snippet: string }>;
        return results.map((r, i) =>
          `${i + 1}. ${r.title}\n   URL: ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`
        ).join('\n\n');
      }
    } catch {}

    // Try headless Chrome directly
    const chrome = this.findChrome();
    if (chrome) {
      const result = spawnSync(chrome, [
        '--headless', '--no-sandbox', '--disable-gpu',
        `--dump-dom`, searchUrl,
      ], { timeout: 15_000, encoding: 'utf8' });
      if (result.stdout) {
        const html = result.stdout;
        const titles = [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/g)]
          .map(m => m[1].replace(/<[^>]+>/g, '').trim())
          .filter(t => t.length > 5)
          .slice(0, n);
        if (titles.length > 0) return titles.map((t, i) => `${i + 1}. ${t}`).join('\n');
      }
    }

    throw new Error('No browser available for fallback search');
  }

  private findChrome(): string | null {
    const candidates = [
      'google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium',
      '/usr/bin/google-chrome', '/usr/bin/chromium-browser',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ];
    for (const c of candidates) {
      try { execSync(`which "${c}" 2>/dev/null || test -f "${c}"`, { stdio: 'pipe' }); return c; } catch {}
    }
    return null;
  }
}
