import type { Capability, CapabilityResult, ToolDefinition } from './types.js';
import { spawnSync } from 'node:child_process';
import { BrowserCapability } from './BrowserCapability.js';

export class ScraperCapability implements Capability {
  readonly name = 'scrape_url';
  readonly description = 'Scrape a URL. Tries fast HTTP fetch, then Scrapling, then browser if needed.';
  private browser = new BrowserCapability();

  readonly toolDefinition: ToolDefinition = {
    name: 'scrape_url',
    description: 'Scrape a URL and return clean content. Handles JS-rendered pages. Fallback chain: HTTP → Scrapling → Browser.',
    input_schema: {
      type: 'object',
      properties: {
        url:      { type: 'string', description: 'URL to scrape' },
        mode:     { type: 'string', description: '"text" (default), "links", "tables", "markdown"' },
        selector: { type: 'string', description: 'Optional CSS selector to target element' },
      },
      required: ['url'],
    },
  };

  async execute(input: Record<string, unknown>, cwd: string): Promise<CapabilityResult> {
    const url = String(input.url ?? '');
    const mode = String(input.mode ?? 'text');
    const selector = input.selector ? String(input.selector) : null;
    const start = Date.now();

    if (!url.startsWith('http')) {
      return { success: false, output: 'URL must start with http:// or https://', duration_ms: 0 };
    }

    // Tier 1: Plain fetch (fastest, no deps)
    try {
      const output = await this.plainFetch(url, mode, selector);
      if (output && output.length > 100) {
        return { success: true, output, duration_ms: Date.now() - start };
      }
    } catch {}

    // Tier 2: Scrapling (Python, auto-installs)
    try {
      const output = await this.scraplingFetch(url, mode);
      if (output && output.length > 100) {
        return { success: true, output, fallback_used: 'scrapling', duration_ms: Date.now() - start };
      }
    } catch {}

    // Tier 3: Browser (for JS-heavy pages)
    const browserResult = await this.browser.execute({ url, extract: selector ?? undefined }, cwd);
    return { ...browserResult, fallback_used: 'browser', duration_ms: Date.now() - start };
  }

  private async plainFetch(url: string, mode: string, selector: string | null): Promise<string> {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 AppleWebKit/537.36 Chrome/120.0' },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();

    if (mode === 'links') {
      const links = [...html.matchAll(/href="(https?:\/\/[^"]+)"/g)]
        .map(m => m[1]).filter((v, i, a) => a.indexOf(v) === i).slice(0, 30);
      return links.join('\n');
    }
    if (mode === 'tables') {
      const tables = [...html.matchAll(/<table[\s\S]*?<\/table>/gi)].map(m =>
        m[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      ).slice(0, 5);
      return tables.join('\n---\n');
    }

    const text = html.replace(/<script[\s\S]*?<\/script>/gi, '')
                     .replace(/<style[\s\S]*?<\/style>/gi, '')
                     .replace(/<[^>]+>/g, ' ')
                     .replace(/\s+/g, ' ').trim();
    return text.slice(0, 6000) + (text.length > 6000 ? '\n…[truncated]' : '');
  }

  private async scraplingFetch(url: string, mode: string): Promise<string> {
    const extractLine = mode === 'links'
      ? `result = [a.attrib.get('href','') for a in page.find_all('a') if a.attrib.get('href','').startswith('http')]`
      : `result = page.get_all_text()`;

    const script = `
import sys
try:
    from scrapling import Fetcher
except ImportError:
    import subprocess
    subprocess.run([sys.executable,'-m','pip','install','scrapling','-q'],check=True)
    from scrapling import Fetcher
f = Fetcher(auto_match=False)
page = f.get('${url}', timeout=20)
${extractLine}
if isinstance(result, list):
    print('\\n'.join(str(r) for r in result[:30]))
else:
    t = str(result).strip()
    print(t[:5000] + ('...' if len(t)>5000 else ''))
`.trim();

    const result = spawnSync('python3', ['-c', script], { timeout: 35_000, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr || 'Scrapling failed');
    return result.stdout.trim();
  }
}
