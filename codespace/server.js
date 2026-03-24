/**
 * 0agent Browser Server — runs inside GitHub Codespace.
 *
 * Provides a Playwright-powered browser via HTTP.
 * Accessed by the local 0agent daemon via `gh codespace ports forward 3000:3001`.
 *
 * Endpoints:
 *   GET  /health        — liveness check
 *   POST /browse        — browse a URL, return text/screenshot/links
 *   POST /search        — Google/DuckDuckGo search (returns results)
 *   POST /scrape        — deep scrape with Scrapling (Python) fallback
 */

const http = require('http');
const { chromium } = require('playwright');
const { execSync, spawnSync } = require('child_process');

const PORT = parseInt(process.env.PORT || '3000', 10);
let browser = null;

async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--window-size=1280,800',
      ],
    });
  }
  return browser;
}

// ─── Route handlers ──────────────────────────────────────────────────────────

async function handleBrowse(body) {
  const { url, action = 'read', selector, wait_for, wait_ms = 0, value } = body;

  if (!url || !url.startsWith('http')) {
    return { ok: false, error: 'url must start with http:// or https://' };
  }

  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    if (wait_for) {
      await page.waitForSelector(wait_for, { timeout: 8000 }).catch(() => {});
    }
    if (wait_ms > 0) {
      await page.waitForTimeout(wait_ms);
    }

    switch (action) {
      case 'screenshot': {
        const buf = await page.screenshot({ type: 'png', fullPage: false });
        return { ok: true, type: 'screenshot', data: buf.toString('base64'), mime: 'image/png' };
      }

      case 'links': {
        const links = await page.$$eval('a[href]', els =>
          els.map(a => ({ text: a.innerText.trim().slice(0, 80), href: a.href }))
             .filter(l => l.href.startsWith('http') && l.text)
             .slice(0, 50)
        );
        return { ok: true, type: 'links', data: JSON.stringify(links, null, 2) };
      }

      case 'click': {
        if (!selector) return { ok: false, error: 'selector required for click' };
        await page.click(selector, { timeout: 5000 });
        await page.waitForTimeout(500); // brief settle
        return { ok: true, type: 'click', data: `Clicked: ${selector}` };
      }

      case 'fill': {
        if (!selector) return { ok: false, error: 'selector required for fill' };
        await page.fill(selector, String(value ?? ''), { timeout: 5000 });
        return { ok: true, type: 'fill', data: `Filled: ${selector}` };
      }

      case 'snapshot': {
        // Accessibility tree — lower token cost than full text
        const snapshot = await page.accessibility.snapshot().catch(() => null);
        return { ok: true, type: 'snapshot', data: JSON.stringify(snapshot, null, 2).slice(0, 8000) };
      }

      default: { // 'read' / 'text'
        let text;
        if (selector) {
          text = await page.$eval(selector, el => el.innerText ?? el.textContent ?? '').catch(() => '');
        } else {
          text = await page.evaluate(() => {
            // Remove script/style noise
            document.querySelectorAll('script,style,nav,footer,header').forEach(el => el.remove());
            return document.body.innerText ?? '';
          });
        }
        return { ok: true, type: 'text', data: text.replace(/\n{3,}/g, '\n\n').trim().slice(0, 8000) };
      }
    }
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    await page.close().catch(() => {});
  }
}

async function handleSearch(body) {
  const { query, engine = 'ddg', num_results = 5 } = body;
  if (!query) return { ok: false, error: 'query required' };

  const searchUrl = engine === 'google'
    ? `https://www.google.com/search?q=${encodeURIComponent(query)}`
    : `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=us-en`;

  // DDG HTML endpoint — parse without full browser
  if (engine !== 'google') {
    try {
      const res = await fetch(searchUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0' },
        signal: AbortSignal.timeout(10_000),
      });
      const html = await res.text();
      const titleRe = /<a[^>]+class="result__a"[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
      const snippetRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
      const titles = [], snippets = [];
      let m;
      while ((m = titleRe.exec(html)) !== null && titles.length < num_results) {
        let href = m[1];
        const title = m[2].replace(/<[^>]+>/g, '').trim();
        const uddg = href.match(/[?&]uddg=([^&]+)/);
        if (uddg) href = decodeURIComponent(uddg[1]);
        if (href.startsWith('http') && title) titles.push({ url: href, title });
      }
      while ((m = snippetRe.exec(html)) !== null && snippets.length < num_results) {
        snippets.push(m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
      }
      if (titles.length > 0) {
        const text = titles.map((t, i) =>
          `${i + 1}. ${t.title}\n   URL: ${t.url}${snippets[i] ? '\n   ' + snippets[i] : ''}`
        ).join('\n\n');
        return { ok: true, type: 'search_results', data: text };
      }
    } catch {}
  }

  // Fallback: full browser search
  const result = await handleBrowse({
    url: searchUrl,
    action: 'read',
    wait_for: engine === 'google' ? '#search' : '.results',
  });
  return result;
}

async function handleScrape(body) {
  const { url, mode = 'text' } = body;
  if (!url) return { ok: false, error: 'url required' };

  // Try Scrapling (Python) — better at structured extraction
  try {
    const script = `
import sys
try:
    from scrapling import Fetcher
except ImportError:
    import subprocess
    subprocess.run([sys.executable,'-m','pip','install','scrapling','-q'],check=True)
    from scrapling import Fetcher
f = Fetcher(auto_match=False)
page = f.get('${url.replace(/'/g, "\\'")}', timeout=20)
${mode === 'links' ? "result = [a.attrib.get('href','') for a in page.find_all('a') if a.attrib.get('href','').startswith('http')]" : "result = page.get_all_text()"}
if isinstance(result, list):
    print('\\n'.join(str(r) for r in result[:30]))
else:
    t = str(result).strip()
    print(t[:6000] + ('...' if len(t)>6000 else ''))
`.trim();

    const out = spawnSync('python3', ['-c', script], { timeout: 30_000, encoding: 'utf8' });
    if (out.status === 0 && out.stdout) {
      return { ok: true, type: 'scrapling', data: out.stdout.trim() };
    }
  } catch {}

  // Fallback to Playwright
  return handleBrowse({ url, action: mode === 'links' ? 'links' : 'read' });
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'GET' && req.url === '/health') {
    res.end(JSON.stringify({ ok: true, env: 'codespace', browser: !!browser }));
    return;
  }

  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end(JSON.stringify({ ok: false, error: 'POST required' }));
    return;
  }

  let body = {};
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    res.statusCode = 400;
    res.end(JSON.stringify({ ok: false, error: 'invalid JSON body' }));
    return;
  }

  let result;
  try {
    if (req.url === '/browse')  result = await handleBrowse(body);
    else if (req.url === '/search') result = await handleSearch(body);
    else if (req.url === '/scrape') result = await handleScrape(body);
    else { res.statusCode = 404; res.end(JSON.stringify({ ok: false, error: 'Not Found' })); return; }
  } catch (err) {
    result = { ok: false, error: err.message };
  }

  res.end(JSON.stringify(result));
});

// Warm up browser at startup
getBrowser().then(() => {
  console.log('[0agent-browser] Browser ready');
}).catch(err => {
  console.error('[0agent-browser] Browser warm-up failed:', err.message);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[0agent-browser] Server ready on :${PORT}`);
});

process.on('SIGTERM', async () => {
  if (browser) await browser.close().catch(() => {});
  server.close();
  process.exit(0);
});
