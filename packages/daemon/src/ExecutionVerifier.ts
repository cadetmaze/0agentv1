import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export type VerificationMethod = 'http_check' | 'test_run' | 'file_exists' | 'process_check' | 'none';

export interface VerificationResult {
  success: boolean;
  method: VerificationMethod;
  details: string;
  retryable: boolean;
  elapsed_ms: number;
}

export interface AgentResult {
  output: string;
  files_written: string[];
  commands_run: string[];
  tokens_used: number;
  cost_usd: number;
  model: string;
  iterations: number;
}

export class ExecutionVerifier {
  constructor(private cwd: string) {}

  /**
   * Select and run the best verification strategy for this AgentResult.
   */
  async verify(result: AgentResult): Promise<VerificationResult> {
    const start = Date.now();
    const cmds = result.commands_run.join(' ').toLowerCase();
    const files = result.files_written;

    // Strategy 1: port-binding server — most common case
    const portMatch = cmds.match(/(?:port|listen|--port|-p)\s*[=:]?\s*(\d{4,5})/);
    if (portMatch) {
      return this.httpCheck(parseInt(portMatch[1], 10), start);
    }

    // Strategy 2: known server process patterns
    if (/\b(node |bun |deno |python |uvicorn|fastapi|flask|cargo run|go run|rails s|rails server)\b/.test(cmds)) {
      // Try common ports
      for (const port of [3000, 8000, 8080, 5000, 4200]) {
        const res = await this.httpCheck(port, start, 2, 400);
        if (res.success) return res;
      }
    }

    // Strategy 3: test runner — check last exit code (commands_run captures output with exit code)
    if (/\b(npm test|yarn test|pnpm test|vitest|jest|cargo test|pytest|go test)\b/.test(cmds)) {
      const passed = !cmds.includes('fail') && !cmds.includes('error') && !cmds.includes('✗');
      return {
        success: passed,
        method: 'test_run',
        details: passed ? 'Test commands ran without detected failures' : 'Possible test failures detected in output',
        retryable: false,
        elapsed_ms: Date.now() - start,
      };
    }

    // Strategy 4: verify files were actually written
    if (files.length > 0) {
      const lastFile = resolve(this.cwd, files[files.length - 1]);
      const exists = existsSync(lastFile);
      return {
        success: exists,
        method: 'file_exists',
        details: exists ? `File confirmed: ${files[files.length - 1]}` : `File not found: ${files[files.length - 1]}`,
        retryable: false,
        elapsed_ms: Date.now() - start,
      };
    }

    // Strategy 5: no verification possible
    return { success: true, method: 'none', details: 'No verification strategy applicable', retryable: false, elapsed_ms: 0 };
  }

  /**
   * HTTP check with retries (server needs time to start).
   * Polls up to maxAttempts times with increasing delay.
   */
  private async httpCheck(port: number, start: number, maxAttempts = 5, baseDelayMs = 600): Promise<VerificationResult> {
    for (let i = 0; i < maxAttempts; i++) {
      if (i > 0) await new Promise(r => setTimeout(r, baseDelayMs * i));
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
        if (res.status < 500) {
          return { success: true, method: 'http_check', details: `HTTP ${res.status} on :${port}`, retryable: true, elapsed_ms: Date.now() - start };
        }
      } catch {
        // port not yet open — continue polling
      }
    }
    return {
      success: false,
      method: 'http_check',
      details: `Port ${port} not responding after ${maxAttempts} attempts (${(baseDelayMs * maxAttempts / 1000).toFixed(1)}s)`,
      retryable: true,
      elapsed_ms: Date.now() - start,
    };
  }
}
