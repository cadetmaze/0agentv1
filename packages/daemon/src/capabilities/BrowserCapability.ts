import type { Capability, CapabilityResult, ToolDefinition } from './types.js';
import { spawnSync, execSync, spawn } from 'node:child_process';
import { platform } from 'node:os';

// Locate the system's installed Chromium/Chrome executable (not Playwright's download)
function findSystemChrome(): string | null {
  const candidates =
    platform() === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
        ]
      : platform() === 'linux'
      ? ['google-chrome', 'chromium-browser', 'chromium', 'microsoft-edge', 'brave-browser']
      : ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'];

  for (const c of candidates) {
    try {
      execSync(`test -f "${c}" 2>/dev/null || which "${c}" 2>/dev/null`, { stdio: 'pipe' });
      return c;
    } catch {}
  }
  return null;
}

export class BrowserCapability implements Capability {
  readonly name = 'browser_open';
  readonly description = 'Headless browser for scraping JS-heavy pages. NOT for user-facing browser automation.';

  readonly toolDefinition: ToolDefinition = {
    name: 'browser_open',
    description:
      'Headless browser — ONLY for reading/scraping page content when scrape_url fails on JS-heavy pages. ' +
      'action="read" (default): extract text headlessly (invisible, no real browser window opened). ' +
      'NEVER use this when the task involves the user\'s real browser or visible UI — use gui_automation with open_url instead. ' +
      'Do NOT use alongside gui_automation for the same URL — pick one.',
    input_schema: {
      type: 'object',
      properties: {
        url:      { type: 'string', description: 'URL to open' },
        action:   { type: 'string', description: '"open" — launch in system browser (visible); "read" — extract text content (default); "screenshot" — take screenshot' },
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

    // action=open: launch URL in the user's default OS browser (visible, non-headless)
    if (action === 'open') {
      return this.openInSystemBrowser(url, start);
    }

    // action=read/screenshot: headless content extraction using system Chrome
    // Tier 1: system Chrome headless (uses user's installed browser, not a downloaded one)
    const sysChromeExe = findSystemChrome();
    if (sysChromeExe) {
      try {
        const output = await this.chromeFetch(sysChromeExe, url);
        return { success: true, output, duration_ms: Date.now() - start };
      } catch {}
    }

    // Tier 2: Playwright with system browser (channel: 'chrome' uses installed Chrome)
    try {
      const output = await this.playwrightFetch(url, action, waitFor, extract);
      return { success: true, output, fallback_used: 'playwright', duration_ms: Date.now() - start };
    } catch {}

    // Tier 3: Plain fetch
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        signal: AbortSignal.timeout(15_000),
      });
      const text = await res.text();
      const plain = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 5000);
      return { success: true, output: plain, fallback_used: 'fetch', duration_ms: Date.now() - start };
    } catch (err) {
      return {
        success: false,
        output: `Browser unavailable. No system Chrome/Chromium found and Playwright not installed.`,
        error: err instanceof Error ? err.message : String(err),
        duration_ms: Date.now() - start,
      };
    }
  }

  private openInSystemBrowser(url: string, start: number): CapabilityResult {
    try {
      const cmd = platform() === 'darwin' ? 'open'
                : platform() === 'win32'  ? 'start'
                : 'xdg-open';
      spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref();
      return { success: true, output: `Opened in default browser: ${url}`, duration_ms: Date.now() - start };
    } catch (err) {
      return { success: false, output: `Failed to open browser: ${err instanceof Error ? err.message : String(err)}`, duration_ms: Date.now() - start };
    }
  }

  private async playwrightFetch(url: string, action: string, waitFor: string | null, extract: string | null): Promise<string> {
    const waitLine = waitFor ? `await p.waitForSelector('${waitFor}', { timeout: 8000 }).catch(() => {});` : '';
    const extractLine = extract
      ? `const text = await p.$eval('${extract}', el => el.innerText).catch(() => page_text);`
      : `const text = page_text;`;

    // Use channel:'chrome' to use the system's installed Chrome, not a downloaded binary
    const script = `
      const { chromium } = require('playwright');
      (async () => {
        let b;
        try {
          b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-sandbox'] });
        } catch {
          b = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
        }
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

  private async chromeFetch(executablePath: string, url: string): Promise<string> {
    const result = spawnSync(executablePath, [
      '--headless=new', '--no-sandbox', '--disable-gpu',
      '--disable-dev-shm-usage', '--dump-dom', url,
    ], { timeout: 15_000, encoding: 'utf8' });
    if (result.status !== 0 || !result.stdout) throw new Error('Chrome headless failed');
    return result.stdout.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 5000);
  }
}
