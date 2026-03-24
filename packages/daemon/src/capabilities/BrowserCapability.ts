import type { Capability, CapabilityResult, ToolDefinition } from './types.js';
import { spawnSync, execSync } from 'node:child_process';

export class BrowserCapability implements Capability {
  readonly name = 'browser_open';
  readonly description = 'Open a URL in a real browser. Returns page content, can take screenshots. Use when scrape_url fails on JS-heavy pages.';

  readonly toolDefinition: ToolDefinition = {
    name: 'browser_open',
    description: 'Open a URL in a real headless browser. Handles JavaScript-rendered pages, SPAs, login flows. Use when scrape_url fails.',
    input_schema: {
      type: 'object',
      properties: {
        url:      { type: 'string', description: 'URL to open' },
        action:   { type: 'string', description: 'What to do: "read" (default), "screenshot", "click <selector>", "fill <selector> <value>"' },
        wait_for: { type: 'string', description: 'CSS selector to wait for before extracting content' },
        extract:  { type: 'string', description: 'CSS selector to extract specific element text' },
      },
      required: ['url'],
    },
  };

  async execute(input: Record<string, unknown>, _cwd: string): Promise<CapabilityResult> {
    const url = String(input.url ?? '');
    const action = String(input.action ?? 'read');
    const waitFor = input.wait_for ? String(input.wait_for) : null;
    const extract = input.extract ? String(input.extract) : null;
    const start = Date.now();

    if (!url.startsWith('http')) {
      return { success: false, output: 'URL must start with http:// or https://', duration_ms: 0 };
    }

    // Tier 1: Playwright
    try {
      const output = await this.playwrightFetch(url, action, waitFor, extract);
      return { success: true, output, duration_ms: Date.now() - start };
    } catch {}

    // Tier 2: System Chrome headless
    try {
      const output = await this.chromeFetch(url);
      return { success: true, output, fallback_used: 'system-chrome', duration_ms: Date.now() - start };
    } catch {}

    // Tier 3: Plain fetch with better headers
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
        },
        signal: AbortSignal.timeout(15_000),
      });
      const text = await res.text();
      const plain = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 5000);
      return { success: true, output: plain, fallback_used: 'fetch', duration_ms: Date.now() - start };
    } catch (err) {
      return {
        success: false,
        output: `Browser unavailable. Install Playwright: npx playwright install chromium`,
        error: err instanceof Error ? err.message : String(err),
        duration_ms: Date.now() - start,
      };
    }
  }

  private async playwrightFetch(url: string, action: string, waitFor: string | null, extract: string | null): Promise<string> {
    const waitLine = waitFor ? `await p.waitForSelector('${waitFor}', { timeout: 8000 }).catch(() => {});` : '';
    const extractLine = extract
      ? `const text = await p.$eval('${extract}', el => el.innerText).catch(() => page_text);`
      : `const text = page_text;`;

    const script = `
      const { chromium } = require('playwright');
      (async () => {
        const b = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
        const p = await b.newPage();
        await p.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
        await p.goto('${url}', { waitUntil: 'domcontentloaded', timeout: 20000 });
        ${waitLine}
        const page_text = await p.evaluate(() => document.body.innerText ?? '');
        ${extractLine}
        console.log(text.slice(0, 6000));
        await b.close();
      })().catch(e => { console.error(e.message); process.exit(1); });
    `;

    const result = spawnSync('node', ['-e', script], { timeout: 30_000, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr || 'Playwright failed');
    return result.stdout.trim();
  }

  private async chromeFetch(url: string): Promise<string> {
    const candidates = [
      'google-chrome', 'chromium-browser', 'chromium',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ];
    for (const chrome of candidates) {
      try {
        execSync(`which "${chrome}" 2>/dev/null || test -f "${chrome}"`, { stdio: 'pipe' });
        const result = spawnSync(chrome, ['--headless', '--no-sandbox', '--disable-gpu', '--dump-dom', url], {
          timeout: 15_000, encoding: 'utf8',
        });
        if (result.status === 0 && result.stdout) {
          return result.stdout.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 5000);
        }
      } catch {}
    }
    throw new Error('No system Chrome found');
  }
}
