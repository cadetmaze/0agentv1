/**
 * Capability Tests — verify each capability actually works.
 *
 * These are integration tests that make real network calls and run real commands.
 * Run them to verify your agent's capabilities before deploying.
 *
 * Usage:
 *   pnpm --filter=@0agent/core test ../../tests/capabilities/
 *
 * Tests marked [NETWORK] require internet access.
 * Tests marked [LOCAL] work offline.
 */

import { describe, it, expect } from 'vitest';
import { CapabilityRegistry } from '../../packages/daemon/src/capabilities/CapabilityRegistry.js';
import { tmpdir } from 'node:os';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const registry = new CapabilityRegistry();
const cwd = tmpdir();

// ─── Registry ─────────────────────────────────────────────────────────────────

describe('CapabilityRegistry', () => {
  it('has all 5 capabilities registered', () => {
    const caps = registry.list();
    const names = caps.map(c => c.name);
    expect(names).toContain('web_search');
    expect(names).toContain('browser_open');
    expect(names).toContain('scrape_url');
    expect(names).toContain('shell_exec');
    expect(names).toContain('file_op');
  });

  it('returns tool definitions for all capabilities', () => {
    const defs = registry.getToolDefinitions();
    expect(defs.length).toBeGreaterThanOrEqual(5); // gui_automation added in v1.0.50+
    for (const def of defs) {
      expect(def.name).toBeTruthy();
      expect(def.description).toBeTruthy();
      expect(def.input_schema.type).toBe('object');
    }
  });

  it('returns error for unknown capability', async () => {
    const result = await registry.execute('nonexistent', {}, cwd);
    expect(result.success).toBe(false);
    expect(result.output).toContain('Unknown capability');
  });
});

// ─── Shell Capability [LOCAL] ─────────────────────────────────────────────────

describe('ShellCapability [LOCAL]', () => {
  it('runs echo command', async () => {
    const result = await registry.execute('shell_exec', { command: 'echo "hello 0agent"' }, cwd);
    expect(result.success).toBe(true);
    expect(result.output).toContain('hello 0agent');
    expect(result.duration_ms).toBeGreaterThan(0);
  });

  it('returns exit code on failure', async () => {
    const result = await registry.execute('shell_exec', { command: 'exit 1' }, cwd);
    expect(result.success).toBe(false);
  });

  it('runs multi-step pipeline', async () => {
    const result = await registry.execute('shell_exec', {
      command: 'echo "line1\nline2\nline3" | wc -l',
    }, cwd);
    expect(result.success).toBe(true);
    expect(result.output.trim()).toBe('3');
  });

  it('handles timeout', async () => {
    const result = await registry.execute('shell_exec', {
      command: 'sleep 10',
      timeout_ms: 300,
    }, cwd);
    expect(result.success).toBe(false);
  });
});

// ─── File Capability [LOCAL] ──────────────────────────────────────────────────

describe('FileCapability [LOCAL]', () => {
  const testDir = resolve(tmpdir(), `0agent-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });

  it('writes a file', async () => {
    const result = await registry.execute('file_op', {
      op: 'write',
      path: 'test.txt',
      content: 'hello from 0agent',
    }, testDir);
    expect(result.success).toBe(true);
    expect(result.output).toContain('test.txt');
    expect(existsSync(resolve(testDir, 'test.txt'))).toBe(true);
  });

  it('reads a file', async () => {
    writeFileSync(resolve(testDir, 'read-me.txt'), 'content to read', 'utf8');
    const result = await registry.execute('file_op', {
      op: 'read',
      path: 'read-me.txt',
    }, testDir);
    expect(result.success).toBe(true);
    expect(result.output).toContain('content to read');
  });

  it('lists a directory', async () => {
    const result = await registry.execute('file_op', { op: 'list', path: '.' }, testDir);
    expect(result.success).toBe(true);
    expect(result.output).toContain('test.txt');
  });

  it('rejects path traversal', async () => {
    const result = await registry.execute('file_op', {
      op: 'read',
      path: '../../../etc/passwd',
    }, testDir);
    expect(result.success).toBe(false);
    expect(result.output).toContain('outside working directory');
  });

  it('returns error for missing file', async () => {
    const result = await registry.execute('file_op', {
      op: 'read',
      path: 'doesnotexist.txt',
    }, testDir);
    expect(result.success).toBe(false);
    expect(result.output).toContain('Not found');
  });
});

// ─── Web Search Capability [NETWORK] ─────────────────────────────────────────

describe('WebSearchCapability [NETWORK]', () => {
  it('searches and returns non-empty output', async () => {
    const result = await registry.execute('web_search', {
      query: 'TypeScript 5 features 2024',
      num_results: 3,
    }, cwd);
    // Should return something — either results or a graceful fallback message
    expect(result.output.length).toBeGreaterThan(10);
    expect(result.duration_ms).toBeLessThan(20_000);
    // If successful, should contain URLs; if blocked, output is non-empty text
    // We don't hard-require URLs since DDG may return a challenge page in CI
  }, 25_000);

  it('handles empty/unusual query gracefully', async () => {
    const result = await registry.execute('web_search', {
      query: 'xkcd comic random today',
      num_results: 2,
    }, cwd);
    // Should not throw, output should be non-empty
    expect(result.output.length).toBeGreaterThan(0);
    expect(result.duration_ms).toBeLessThan(15_000);
  }, 20_000);
});

// ─── Scraper Capability [NETWORK] ─────────────────────────────────────────────

describe('ScraperCapability [NETWORK]', () => {
  it('scrapes a simple page', async () => {
    const result = await registry.execute('scrape_url', {
      url: 'https://example.com',
      mode: 'text',
    }, cwd);
    expect(result.success).toBe(true);
    expect(result.output).toContain('Example');
    expect(result.duration_ms).toBeLessThan(15_000);
  }, 20_000);

  it('extracts links from a page', async () => {
    const result = await registry.execute('scrape_url', {
      url: 'https://example.com',
      mode: 'links',
    }, cwd);
    // example.com has at least one link (IANA)
    expect(result.output.length).toBeGreaterThan(0);
  }, 20_000);

  it('rejects non-http URLs', async () => {
    const result = await registry.execute('scrape_url', {
      url: 'ftp://example.com',
    }, cwd);
    expect(result.success).toBe(false);
  });
});

// ─── Capability report ────────────────────────────────────────────────────────

describe('Capability availability report', () => {
  it('prints which capabilities are available', async () => {
    const checks = [
      { name: 'shell_exec', input: { command: 'echo ok' } },
      { name: 'file_op',    input: { op: 'list', path: '.' } },
      { name: 'web_search', input: { query: 'test', num_results: 1 } },
      { name: 'scrape_url', input: { url: 'https://example.com' } },
      { name: 'browser_open', input: { url: 'https://example.com', action: 'read' } },
    ];

    console.log('\n  ── Capability Report ──────────────────────');
    for (const check of checks) {
      try {
        const result = await registry.execute(check.name, check.input, cwd);
        const status = result.success ? '✓' : '✗';
        const fb = result.fallback_used ? ` (fallback: ${result.fallback_used})` : '';
        console.log(`  ${status} ${check.name.padEnd(16)} ${result.duration_ms}ms${fb}`);
      } catch (err) {
        console.log(`  ✗ ${check.name.padEnd(16)} ERROR: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    console.log('  ──────────────────────────────────────────\n');

    // This test always passes — it's just a report
    expect(true).toBe(true);
  }, 60_000);
});
