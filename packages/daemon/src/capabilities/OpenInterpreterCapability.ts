/**
 * OpenInterpreterCapability — autonomous computer use via Open Interpreter.
 *
 * Replaces the PyAutoGUI-based GUICapability with a smarter, autonomous
 * approach: describe what you want done in plain English, and Open Interpreter
 * (powered by Claude Haiku) figures out how to do it — whether that means
 * browser automation, GUI clicks, keyboard shortcuts, screenshots, or scripts.
 *
 * Under the hood:
 *   - Spawns a Python subprocess running open-interpreter
 *   - Configures it to use Claude Haiku (claude-haiku-4-5-20251001)
 *   - auto_run=True so it executes code without confirmation prompts
 *   - Auto-installs open-interpreter on first use (pip install open-interpreter)
 *
 * API key: reads ANTHROPIC_API_KEY from the environment (set by ZeroAgentDaemon
 * from the first Anthropic provider in llm_providers config).
 *
 * Handles: browser tasks, clicking, typing, keyboard shortcuts, screenshots,
 * opening apps, form filling, web navigation, file GUI operations, and any
 * task that requires controlling the screen or installed applications.
 *
 * @see https://github.com/openinterpreter/open-interpreter
 */

import type { Capability, CapabilityResult, ToolDefinition } from './types.js';
import { spawn } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

// Python script: reads task from stdin, runs via open-interpreter + Claude Haiku
const OI_SCRIPT = `
import sys
import os

task = sys.stdin.read().strip()
if not task:
    print("No task provided")
    sys.exit(1)

try:
    from interpreter import interpreter
except ImportError:
    print("__MISSING_MODULE__: open-interpreter")
    sys.exit(127)

# Claude Haiku 4.5 — fast, capable, cost-efficient for computer use
interpreter.llm.model = "claude-haiku-4-5-20251001"
interpreter.auto_run = True      # execute code without asking for confirmation
interpreter.verbose = False
interpreter.offline = False
interpreter.safe_mode = "off"    # trust the agent loop

# Run the task and collect all output
try:
    messages = interpreter.chat(task, display=False, stream=False)
except Exception as e:
    print(f"Error: {e}", file=sys.stderr)
    sys.exit(1)

# Extract assistant text from the message list
result_parts = []
for msg in messages:
    if not isinstance(msg, dict):
        continue
    if msg.get("role") != "assistant":
        continue
    content = msg.get("content", "")
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                text = block.get("text", "").strip()
                if text:
                    result_parts.append(text)
    elif isinstance(content, str) and content.strip():
        result_parts.append(content.strip())

output = "\\n".join(result_parts).strip()
print(output if output else "Task completed successfully")
`;

export class OpenInterpreterCapability implements Capability {
  readonly name = 'computer_use';
  readonly description =
    'Autonomous computer use — browse web, click, type, keyboard, screenshots, open apps. ' +
    'Powered by Open Interpreter + Claude Haiku. Describe the goal; it figures out the steps.';

  readonly toolDefinition: ToolDefinition = {
    name: 'computer_use',
    description:
      'Autonomous computer use powered by Open Interpreter + Claude Haiku. ' +
      'Give a plain-English description of what to do — it decides HOW (browser automation, ' +
      'GUI clicks, keyboard shortcuts, screenshots, scripts). ' +
      'Use for: web navigation, form filling, clicking UI elements, typing in apps, ' +
      'taking screenshots, opening applications, file manager operations, or any task ' +
      'that requires interacting with the desktop or browser. ' +
      'DO NOT use for tasks that can be done with file_op, shell_exec, or web_search alone.',
    input_schema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description:
            'Plain-English description of what to accomplish. Be specific about what ' +
            'you want to see happen. Examples: "Open Chrome and go to github.com", ' +
            '"Take a screenshot and describe what is on screen", ' +
            '"Click the Submit button on the login form", ' +
            '"Type hello world into the text editor that is open".',
        },
        context: {
          type: 'string',
          description:
            'Optional: extra context about the current screen state or prior steps ' +
            '(e.g. "Chrome is open on example.com/login"). Helps the interpreter ' +
            'start faster without needing an initial screenshot.',
        },
      },
      required: ['task'],
    },
  };

  async execute(input: Record<string, unknown>, _cwd: string, signal?: AbortSignal): Promise<CapabilityResult> {
    const start = Date.now();
    // Accept both {task: "..."} (preferred) and legacy {action: "...", ...} format
    let task = String(input.task ?? '').trim();
    if (!task && input.action) {
      // Convert legacy gui_automation-style input into a natural language task
      const action = String(input.action);
      const parts: string[] = [`Action: ${action}`];
      for (const [k, v] of Object.entries(input)) {
        if (k !== 'action') parts.push(`${k}: ${v}`);
      }
      task = parts.join(', ');
    }
    const context = input.context ? String(input.context).trim() : '';

    if (!task) {
      return { success: false, output: 'task is required — provide either {task: "description"} or {action: "..."}', duration_ms: 0 };
    }

    const fullTask = context ? `Context: ${context}\n\nTask: ${task}` : task;

    const tmpFile = resolve(tmpdir(), `0agent_oi_${Date.now()}.py`);
    writeFileSync(tmpFile, OI_SCRIPT, 'utf8');

    let result = await this._runScript(tmpFile, fullTask, signal);
    try { unlinkSync(tmpFile); } catch {}

    if (signal?.aborted) {
      return { success: false, output: 'Cancelled.', duration_ms: Date.now() - start };
    }

    // Auto-install open-interpreter on first use (async — must not block the event loop)
    if (result.stdout.includes('__MISSING_MODULE__') || result.code === 127) {
      const installOk = await this._pipInstall('open-interpreter', signal);
      if (!installOk) {
        return {
          success: false,
          output:
            `open-interpreter is not installed and auto-install failed.\n` +
            `Run manually: pip3 install open-interpreter`,
          duration_ms: Date.now() - start,
        };
      }

      // Retry after install
      writeFileSync(tmpFile, OI_SCRIPT, 'utf8');
      result = await this._runScript(tmpFile, fullTask, signal);
      try { unlinkSync(tmpFile); } catch {}

      if (signal?.aborted) {
        return { success: false, output: 'Cancelled.', duration_ms: Date.now() - start };
      }
    }

    if (result.code === 0) {
      const out = result.stdout.trim() || 'Task completed successfully';
      return { success: true, output: out, duration_ms: Date.now() - start };
    }

    const errMsg = result.stderr.trim() || result.stdout.trim() || 'Open Interpreter exited with error';
    return {
      success: false,
      output: `computer_use error: ${errMsg.slice(0, 500)}`,
      duration_ms: Date.now() - start,
    };
  }

  /** Async pip install — never blocks the event loop (unlike spawnSync). */
  private _pipInstall(pkg: string, signal?: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn('pip3', ['install', pkg, '-q'], {
        env: process.env,
        stdio: 'ignore',
      });
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        clearTimeout(timer);
        resolve(ok);
      };
      const onAbort = () => { try { proc.kill('SIGKILL'); } catch {} finish(false); };
      signal?.addEventListener('abort', onAbort, { once: true });
      proc.on('exit', (code) => finish(code === 0));
      proc.on('error', () => finish(false));
      const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} finish(false); }, 180_000);
    });
  }

  private _runScript(
    scriptPath: string,
    stdinData: string,
    signal?: AbortSignal,
  ): Promise<{ stdout: string; stderr: string; code: number | null }> {
    return new Promise((resolve) => {
      const proc = spawn('python3', [scriptPath], {
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const out: string[] = [];
      const err: string[] = [];
      let settled = false;

      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        clearTimeout(timer);
        resolve({ stdout: out.join(''), stderr: err.join(''), code });
      };

      const onAbort = () => {
        try { proc.kill('SIGKILL'); } catch {}
        finish(null);
      };

      signal?.addEventListener('abort', onAbort, { once: true });
      proc.stdout.on('data', (d: Buffer) => out.push(d.toString()));
      proc.stderr.on('data', (d: Buffer) => err.push(d.toString()));
      proc.on('exit', finish);
      proc.on('error', () => finish(-1));

      // Write task via stdin then close
      proc.stdin.write(stdinData, 'utf8');
      proc.stdin.end();

      // 5-minute timeout — computer use tasks can take time
      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
        finish(null);
      }, 300_000);
    });
  }
}
