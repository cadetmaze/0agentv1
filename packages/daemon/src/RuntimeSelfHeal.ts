/**
 * RuntimeSelfHeal — the agent fixes its own runtime bugs.
 *
 * When a session fails with an error that looks like a code bug (stack trace
 * pointing to daemon/core source), this module:
 *   1. Classifies: is this a CODE bug or a TASK failure?
 *   2. Reads the relevant source file
 *   3. Asks the LLM to propose a fix
 *   4. Emits a WS event with the diff for human approval
 *   5. If approved: patches the source, rebuilds bundle, restarts daemon
 *   6. Retries the original task
 *
 * Human approval is ALWAYS required. The daemon never self-patches silently.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, spawn } from 'node:child_process';
import type { LLMExecutor } from './LLMExecutor.js';
import type { IEventBus } from './WebSocketEvents.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface StackLocation {
  file: string;   // absolute path
  line: number;
  col: number;
  relPath: string; // relative to project root
}

export interface HealProposal {
  proposal_id: string;
  error_summary: string;
  location: StackLocation;
  original_code: string;    // the section with the bug
  proposed_code: string;    // the fixed version
  diff: string;             // human-readable diff
  explanation: string;      // why the fix works
  confidence: 'high' | 'medium' | 'low';
}

export interface HealResult {
  applied: boolean;
  restarted: boolean;
  message: string;
}

// ─── Heuristics ───────────────────────────────────────────────────────────────

const RUNTIME_BUG_PATTERNS = [
  /packages\/(daemon|core|subagent|mcp-hub)\/src\//,
  /dist\/daemon\.mjs/,
  /TypeError: Cannot read propert/,
  /TypeError: .+ is not a function/,
  /ReferenceError: .+ is not defined/,
  /TypeError: Cannot set propert/,
  /TypeError: .+ is undefined/,
];

const TASK_FAILURE_PATTERNS = [
  /Anthropic \d{3}:/,        // API error — not our bug
  /HTTP \d{3}/,              // HTTP error
  /ENOENT/,                  // file not found
  /EACCES/,                  // permission denied
  /AbortError/,              // timeout
  /network/i,                // network issue
];

export function isRuntimeBug(error: string): boolean {
  if (TASK_FAILURE_PATTERNS.some(p => p.test(error))) return false;
  return RUNTIME_BUG_PATTERNS.some(p => p.test(error));
}

// ─── Stack trace parsing ──────────────────────────────────────────────────────

export function parseStackTrace(stack: string): StackLocation | null {
  // Match: "at Something (file:///...packages/daemon/src/File.ts:123:45)"
  // Or:    "at Something (file:///...dist/daemon.mjs:1234:56)"
  const lines = stack.split('\n');
  for (const line of lines) {
    const match = line.match(/\((.+):(\d+):(\d+)\)/) ?? line.match(/at (.+):(\d+):(\d+)$/);
    if (!match) continue;

    let filePath = match[1];
    if (filePath.startsWith('file://')) filePath = fileURLToPath(filePath);
    if (!filePath.includes('packages') && !filePath.includes('dist/daemon')) continue;

    return {
      file: filePath,
      line: parseInt(match[2], 10),
      col: parseInt(match[3], 10),
      relPath: filePath.replace(/.*\/0agent[^/]*\//, ''),
    };
  }
  return null;
}

// ─── Code context extraction ──────────────────────────────────────────────────

function extractContext(filePath: string, errorLine: number, contextLines = 30): string | null {
  try {
    if (!existsSync(filePath)) return null;
    const content = readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    const start = Math.max(0, errorLine - contextLines);
    const end = Math.min(lines.length, errorLine + contextLines);
    return lines.slice(start, end).map((l, i) => {
      const lineNum = start + i + 1;
      const marker = lineNum === errorLine ? '>>>' : '   ';
      return `${marker} ${String(lineNum).padStart(4)} | ${l}`;
    }).join('\n');
  } catch { return null; }
}

// ─── RuntimeSelfHeal ─────────────────────────────────────────────────────────

export class RuntimeSelfHeal {
  private projectRoot: string;

  constructor(
    private llm: LLMExecutor,
    private eventBus: IEventBus,
  ) {
    // Find project root (where package.json lives)
    let dir = dirname(fileURLToPath(import.meta.url));
    while (dir !== '/' && !existsSync(resolve(dir, 'package.json'))) {
      dir = resolve(dir, '..');
    }
    this.projectRoot = dir;
  }

  /**
   * Analyze an error and propose a code fix.
   * Returns null if the error is a task failure (not a code bug).
   */
  async analyze(error: string, task: string): Promise<HealProposal | null> {
    if (!isRuntimeBug(error)) return null;

    const location = parseStackTrace(error);
    if (!location) return null;

    // Try to read the TypeScript source (preferred) or bundle
    const tsPath = this.findSourceFile(location);
    const codePath = tsPath ?? location.file;
    const context = extractContext(codePath, location.line);
    if (!context) return null;

    const proposal = await this.proposeFix(error, task, codePath, location.line, context);
    return proposal;
  }

  /**
   * Emit a WS event to notify the chat TUI that a heal proposal is ready.
   * The human must call applyPatch() after approving.
   */
  emitProposal(proposal: HealProposal): void {
    this.eventBus.emit({
      type: 'runtime.heal_proposal',
      proposal,
    });
  }

  /**
   * Apply an approved patch to the source file, rebuild bundle, restart daemon.
   * Called only after human approval.
   */
  async applyPatch(proposal: HealProposal): Promise<HealResult> {
    const tsPath = this.findSourceFile(proposal.location);

    if (!tsPath || !existsSync(tsPath)) {
      // Can't find TypeScript source — show instructions instead
      return {
        applied: false,
        restarted: false,
        message: 'Source files not found. If running from source, apply the fix manually and rebuild.',
      };
    }

    try {
      // 1. Backup original
      const original = readFileSync(tsPath, 'utf8');
      const backup = tsPath + '.bak';
      writeFileSync(backup, original, 'utf8');

      // 2. Apply the fix
      if (!original.includes(proposal.original_code.trim())) {
        return {
          applied: false,
          restarted: false,
          message: 'Could not locate the code section to patch. The file may have changed.',
        };
      }
      const patched = original.replace(proposal.original_code, proposal.proposed_code);
      writeFileSync(tsPath, patched, 'utf8');

      // 3. Rebuild bundle (if build scripts are available)
      const bundleScript = resolve(this.projectRoot, 'scripts', 'bundle.mjs');
      if (existsSync(bundleScript)) {
        try {
          execSync(`node "${bundleScript}"`, {
            cwd: this.projectRoot,
            timeout: 60_000,
            stdio: 'ignore',
          });
        } catch {
          // Bundle failed — restore backup
          writeFileSync(tsPath, original, 'utf8');
          return {
            applied: false,
            restarted: false,
            message: 'Bundle rebuild failed. Backup restored. Fix may have introduced a syntax error.',
          };
        }
      }

      // 4. Schedule restart (slight delay to allow response to be sent)
      setTimeout(() => this.restartDaemon(), 1500);

      return {
        applied: true,
        restarted: true,
        message: `Patched ${proposal.location.relPath}. Restarting daemon...`,
      };
    } catch (err) {
      return {
        applied: false,
        restarted: false,
        message: `Failed to apply patch: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private findSourceFile(location: StackLocation): string | null {
    // Try resolving relative to project root
    const candidates = [
      resolve(this.projectRoot, location.relPath),
      // If relPath starts with dist/, look in src/
      resolve(this.projectRoot, location.relPath.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts')),
      resolve(this.projectRoot, 'packages', 'daemon', 'src', location.relPath.replace(/.*src\//, '')),
      resolve(this.projectRoot, 'packages', 'core', 'src', location.relPath.replace(/.*src\//, '')),
    ];

    for (const p of candidates) {
      if (existsSync(p)) return p;
    }
    return null;
  }

  private async proposeFix(
    error: string,
    task: string,
    filePath: string,
    errorLine: number,
    codeContext: string,
  ): Promise<HealProposal> {
    const systemPrompt = `You are an expert TypeScript/Node.js debugger analyzing a runtime error in the 0agent codebase.
Your job: identify the exact bug and propose a minimal, surgical fix.
Return ONLY valid JSON — no markdown, no explanation outside the JSON.`;

    const userPrompt = `Runtime error in the 0agent daemon:

ERROR:
${error.slice(0, 1000)}

TASK THAT TRIGGERED IT:
${task.slice(0, 200)}

CODE CONTEXT (>>> marks error line):
${codeContext}

FILE: ${filePath}

Respond with this exact JSON structure:
{
  "explanation": "one-sentence explanation of the bug",
  "confidence": "high|medium|low",
  "original_code": "exact code string to replace (must match file exactly)",
  "proposed_code": "fixed replacement code",
  "diff": "human-readable before/after showing the change"
}

Rules:
- original_code must be an EXACT substring of the file (copy-paste from context above)
- proposed_code must be syntactically valid TypeScript
- Make the minimal change that fixes the bug
- If you cannot determine a safe fix, set confidence to "low" and explain why`;

    try {
      const response = await this.llm.complete(
        [{ role: 'user', content: userPrompt }],
        systemPrompt,
      );

      const json = JSON.parse(response.content.trim()
        .replace(/^```json\n?/, '').replace(/\n?```$/, ''));

      return {
        proposal_id: crypto.randomUUID().slice(0, 8),
        error_summary: error.split('\n')[0].slice(0, 120),
        location: { file: filePath, line: errorLine, col: 0, relPath: filePath.replace(this.projectRoot + '/', '') },
        original_code: json.original_code ?? '',
        proposed_code: json.proposed_code ?? '',
        diff: json.diff ?? '',
        explanation: json.explanation ?? '',
        confidence: json.confidence ?? 'medium',
      };
    } catch {
      return {
        proposal_id: crypto.randomUUID().slice(0, 8),
        error_summary: error.split('\n')[0].slice(0, 120),
        location: { file: filePath, line: errorLine, col: 0, relPath: filePath.replace(this.projectRoot + '/', '') },
        original_code: '',
        proposed_code: '',
        diff: '',
        explanation: 'Could not generate a fix proposal.',
        confidence: 'low',
      };
    }
  }

  private restartDaemon(): void {
    // Spawn a fresh daemon process, then exit this one
    const bundlePath = resolve(this.projectRoot, 'dist', 'daemon.mjs');
    if (existsSync(bundlePath)) {
      const child = spawn(process.execPath, [bundlePath], {
        detached: true,
        stdio: 'ignore',
        env: process.env,
      });
      child.unref();
    }
    setTimeout(() => process.exit(0), 200);
  }
}
