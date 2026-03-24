# Phase Collab-2: "Actually Do It" — Execution Quality + Proactive Intelligence

## Goal

The agent doesn't just execute a task and report back — it verifies the result actually worked, self-heals on failure, and surfaces relevant signals before you ask. This phase adds a verification loop to every `AgentExecutor` run, a self-healing retry mechanism with contextual error feedback, a background worker that watches for test failures and git anomalies, and a deep project scan that gives the agent full codebase awareness before it writes a single line.

This phase builds directly on Phase Collab-1 (`ProjectScanner`, `ConversationStore`, `IdentityManager`) and the existing `AgentExecutor` (shipped in the "Real Execution" update). It extends `BackgroundWorkers` with a new polling worker and extends `WebSocketEventBus` with 4 new event types.

---

## Complete File List

### New files — packages/daemon/src/

| File | Responsibility |
|------|----------------|
| `src/ExecutionVerifier.ts` | Post-execution verification. Selects the right strategy (HTTP check, test run, file exists, process check) based on what the agent did, runs it, returns `VerificationResult`. |
| `src/SelfHealLoop.ts` | Wraps `AgentExecutor`. If `ExecutionVerifier` returns `success: false` and `retryable: true`, re-runs the agent with enriched error context. Max 3 attempts. Emits `session.heal_attempt` WS event per retry. |
| `src/ProactiveSurface.ts` | Background worker registered in `BackgroundWorkers`. Polls for test failures, git anomalies, and error logs. Stores findings as `SIGNAL` nodes in the graph. Emits `agent.insight` WS event. |
| `src/DeepProjectScanner.ts` | Extends `ProjectScanner` output with: full TODO/FIXME scan (depth 3), recently failing test output files, file structure map (depth 3), most-changed files from `git log --stat`. Cached per project for 5 minutes. |

### Modified files

| File | Change |
|------|--------|
| `packages/daemon/src/AgentExecutor.ts` | After `execute()` completes, call `ExecutionVerifier.verify()`. If verification fails, hand off to `SelfHealLoop.heal()`. The final `AgentResult` includes `verification: VerificationResult`. |
| `packages/daemon/src/BackgroundWorkers.ts` | Register `ProactiveSurface` as a new worker with a 30-second poll interval. Pass `graph`, `eventBus`, and project `cwd` to it. |
| `packages/daemon/src/WebSocketEvents.ts` | Add 4 new event types to `DaemonEvent` union (see interfaces below). |
| `packages/daemon/src/SessionManager.ts` | Use `DeepProjectScanner` instead of `ProjectScanner` when the `deep_scan` option is set (default: true for `0agent run`, false for rapid `chat` turns). |
| `bin/0agent.js` | `0agent run` output shows verification status line. `0agent chat` greeting fetches and displays pending proactive insights from the API. |

### New API route

| File | Change |
|------|--------|
| `packages/daemon/src/routes/insights.ts` | New Hono route module. `GET /api/insights` returns unseen `ProactiveInsight[]`. `POST /api/insights/:id/seen` marks as seen. |
| `packages/daemon/src/HTTPServer.ts` | Mount `insightsRoutes` at `/api/insights`. |

---

## Key Interfaces and Types

```typescript
// packages/daemon/src/ExecutionVerifier.ts

export type VerificationMethod =
  | 'http_check'     // curl localhost:PORT, expect HTTP 2xx
  | 'test_run'       // run detected test command (npm test, cargo test, pytest)
  | 'file_exists'    // check that a specific file was actually written
  | 'process_check'  // check that a process is running on a port or by name
  | 'none';          // no verification possible — pass through

export interface VerificationResult {
  success: boolean;
  method: VerificationMethod;
  details: string;   // human-readable: "HTTP 200 on :3000" or "port 3000 not responding after 3s"
  retryable: boolean; // false for file_exists (file was written or not); true for http/process checks
  elapsed_ms: number;
}

export interface VerificationStrategy {
  method: VerificationMethod;
  // Configured by ExecutionVerifier based on AgentResult.commands_run + files_written
  port?: number;
  file_path?: string;
  test_command?: string;
  process_name?: string;
}
```

```typescript
// packages/daemon/src/SelfHealLoop.ts

export interface HealAttempt {
  attempt_number: number;   // 1, 2, or 3
  error_context: string;    // what failed: verification details + last agent output
  result: AgentResult;
  verification: VerificationResult;
}

export interface HealResult {
  final_success: boolean;
  attempts: HealAttempt[];
  total_iterations: number;  // sum of AgentResult.iterations across all attempts
  total_tokens: number;
}
```

```typescript
// packages/daemon/src/ProactiveSurface.ts

export type InsightType =
  | 'test_failure'   // test output file contains failures since last commit
  | 'pr_comment'     // GitHub MCP detected a new PR review comment
  | 'git_anomaly'    // commit pattern broken: e.g. large file added, force push detected
  | 'error_spike'    // log file error rate jumped
  | 'opportunity';   // positive: e.g. dependency update available, unused skill detected

export interface ProactiveInsight {
  id: string;              // nanoid
  type: InsightType;
  summary: string;         // one-line: "2 tests failing since commit abc1234"
  detail: string;          // full context: which tests, which lines
  suggested_action: string; // "Run /debug on auth.test.ts"
  created_at: number;
  seen: boolean;
  entity_id: string;       // which user this insight belongs to
  project_cwd: string;     // which project it was found in
  signal_node_id?: string; // if stored as a SIGNAL node in the graph
}
```

```typescript
// packages/daemon/src/DeepProjectScanner.ts

export interface DeepProjectContext {
  // All fields from ProjectContext (Phase Collab-1) plus:
  open_todos: TodoItem[];          // up to 20 TODO/FIXME with file + line
  failing_tests: FailingTest[];    // from test output files (jest/vitest/cargo/pytest output)
  file_structure: FileTreeNode[];  // depth-3 tree starting at cwd, excludes node_modules/.git
  hot_files: HotFile[];            // files with most commits in last 30 days (git log --stat)
  scanned_at: number;
}

export interface TodoItem {
  file: string;   // relative path
  line: number;
  text: string;   // the TODO/FIXME comment text
  type: 'TODO' | 'FIXME' | 'HACK' | 'XXX';
}

export interface FailingTest {
  file: string;
  test_name: string;
  error_summary: string; // first 200 chars of failure message
  detected_from: string; // path to test output file that was parsed
}

export interface FileTreeNode {
  name: string;
  type: 'file' | 'dir';
  children?: FileTreeNode[];
}

export interface HotFile {
  path: string;   // relative path
  commits: number; // commit count in last 30 days
}
```

```typescript
// packages/daemon/src/WebSocketEvents.ts — additions to DaemonEvent union

| { type: 'agent.insight';       insight: ProactiveInsight }
| { type: 'session.verify';      session_id: string; method: VerificationMethod; success: boolean; details: string }
| { type: 'session.heal_attempt'; session_id: string; attempt: number; error_context: string }
| { type: 'session.verified';    session_id: string; method: VerificationMethod; elapsed_ms: number }
```

```typescript
// packages/daemon/src/AgentExecutor.ts — extended AgentResult

export interface AgentResult {
  output: string;
  files_written: string[];
  commands_run: string[];
  tokens_used: number;
  model: string;
  iterations: number;
  verification?: VerificationResult;  // added in Collab-2
  heal_result?: HealResult;           // present only if self-heal was triggered
}
```

---

## Implementation Order

### Step 1 — ExecutionVerifier (standalone, no AgentExecutor changes yet)
Build the verification strategy selector. Given an `AgentResult`, inspect `commands_run` for patterns: if any command mentions `port` or starts a server → choose `http_check` with detected port. If commands include `npm test`, `cargo test`, or `pytest` → choose `test_run`. If `files_written` is non-empty → choose `file_exists` on the last written file. Otherwise → `none`. Write unit tests with mocked `AgentResult` instances.

### Step 2 — SelfHealLoop (depends on ExecutionVerifier)
Build a simple loop: run verifier → if fail and retryable → build error context string → re-run AgentExecutor with original task + error context appended to `systemContext` → repeat up to 3 times. Emit `session.heal_attempt` via `eventBus` at each retry start. Return `HealResult`.

### Step 3 — Wire ExecutionVerifier + SelfHealLoop into AgentExecutor
After the main `execute()` method completes, call `verifier.verify()`. If it fails, call `selfHealLoop.heal()`. Attach `verification` and `heal_result` to the returned `AgentResult`. The `AgentExecutor` constructor needs `ExecutionVerifier` and `SelfHealLoop` injected (or built internally with a config flag `verification_enabled: boolean`, default true).

### Step 4 — DeepProjectScanner (extends ProjectScanner)
Use `ProjectScanner.scan()` as the base. Add TODO scanning via a recursive `grep -r "TODO\|FIXME\|HACK\|XXX"` call limited to `--include="*.ts" --include="*.js" --include="*.py" --include="*.rs"` at depth 3. Parse test output files by looking for common locations: `test-results/`, `coverage/`, `.vitest/`, `target/nextest/`. Parse git log stat output for hot files.

### Step 5 — ProactiveSurface background worker
Implement `ProactiveSurface` as a class with a `poll()` method. `BackgroundWorkers` calls `poll()` every 30 seconds. `poll()` runs: (a) git log check — compare current HEAD with last known HEAD, extract commit messages, look for anomalies (commits with large file additions via `--stat`); (b) test output file freshness — if test output file is newer than last poll and contains failures, create insight; (c) optional GitHub MCP call if `packages/mcp-hub` has GitHub configured. Store each new insight as a `SIGNAL` node in KnowledgeGraph (using `NodeType.SIGNAL`), then emit `agent.insight` WS event.

### Step 6 — API route + bin/0agent.js updates
Add `GET /api/insights` and `POST /api/insights/:id/seen` to `HTTPServer`. Update `bin/0agent.js` `runChat()` to call `GET /api/insights?seen=false` on startup and print them as a greeting block. Update `runTask()` to print a verification status line at the end.

---

## Critical Algorithms

### Verification Strategy Selection

```typescript
function selectStrategy(result: AgentResult, cwd: string): VerificationStrategy {
  const cmds = result.commands_run.join(' ').toLowerCase();
  const files = result.files_written;

  // 1. Port-binding command pattern
  const portMatch = cmds.match(/(?:port|listen|--port|-p)\s*[=:]?\s*(\d{4,5})/);
  if (portMatch) {
    return { method: 'http_check', port: parseInt(portMatch[1]) };
  }

  // 2. Server start patterns (node server.js, python app.py, cargo run, etc.)
  if (/(?:node|bun|deno|python|uvicorn|cargo run|go run)/.test(cmds)) {
    // Default to port 3000 if no port was specified
    return { method: 'process_check', port: 3000 };
  }

  // 3. Test command patterns
  if (/(?:npm test|yarn test|pnpm test|vitest|jest|cargo test|pytest|go test)/.test(cmds)) {
    const testCmd = extractTestCommand(cmds);
    return { method: 'test_run', test_command: testCmd };
  }

  // 4. File write verification — last file written
  if (files.length > 0) {
    return { method: 'file_exists', file_path: files[files.length - 1] };
  }

  return { method: 'none' };
}
```

### HTTP Check with Retry (ExecutionVerifier)

```typescript
async function httpCheck(port: number, maxAttempts = 5, delayMs = 600): Promise<VerificationResult> {
  // Server might need time to start — poll with increasing delay
  for (let i = 0; i < maxAttempts; i++) {
    if (i > 0) await sleep(delayMs * i); // 600ms, 1200ms, 1800ms, 2400ms
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
      if (res.status < 500) {
        return { success: true, method: 'http_check', details: `HTTP ${res.status} on :${port}`, retryable: true, elapsed_ms: ... };
      }
    } catch {}
  }
  return { success: false, method: 'http_check', details: `port ${port} not responding after ${maxAttempts} attempts`, retryable: true, elapsed_ms: ... };
}
```

### Self-Heal Error Context Construction

On each retry, `SelfHealLoop` builds an enriched error context string that is appended to `systemContext` for the next `AgentExecutor.execute()` call:

```
--- PREVIOUS ATTEMPT FAILED (attempt {N} of 3) ---
Verification method: {method}
Failure detail: {details}
Last agent output excerpt: {output.slice(-800)}
Commands that ran: {commands_run.join(', ')}
Files written: {files_written.join(', ')}
Try a different approach. If a server failed to start, check for port conflicts or missing dependencies.
--- END FAILURE CONTEXT ---
```

### ProactiveSurface — Git Anomaly Detection

```typescript
// Runs every 30 seconds via BackgroundWorkers
async function pollGitChanges(cwd: string, lastKnownHead: string): Promise<ProactiveInsight[]> {
  const currentHead = execSync('git rev-parse HEAD', { cwd, timeout: 1000 }).toString().trim();
  if (currentHead === lastKnownHead) return [];

  // New commits since last poll
  const log = execSync(`git log ${lastKnownHead}..HEAD --stat --oneline`, { cwd, timeout: 2000 }).toString();

  const insights: ProactiveInsight[] = [];

  // Anomaly: large file added (>500KB)
  const largeFileMatch = log.match(/(\d+) insertions.*?(\d+) files? changed/);
  if (largeFileMatch && parseInt(largeFileMatch[1]) > 5000) {
    insights.push(buildInsight('git_anomaly', `Large commit: ${largeFileMatch[1]} lines added`, ...));
  }

  return insights;
}
```

### Test Output File Parser

Look for these output file patterns in `cwd`:
- `test-results/*.xml` (JUnit XML — used by vitest, jest, pytest)
- `target/nextest/*/junit.xml` (cargo-nextest)
- `.test-output` (custom — written by 0agent skills if they run tests)

Parse JUnit XML: count `<failure>` elements, extract `classname` and `message` attributes. Limit to 10 failures for insight construction.

---

## External Dependencies Needed

| Package | Version | Reason |
|---------|---------|--------|
| `node:fs` | built-in | Test output file reading in `ProactiveSurface` |
| `node:child_process` | built-in | `execSync` for git polling in `ProactiveSurface` and `DeepProjectScanner` |
| `node:net` | built-in | Port probing in `ExecutionVerifier` |
| `node:fetch` | built-in (Node 18+) | HTTP check in `ExecutionVerifier` |
| `fast-xml-parser` | `^4.x` | JUnit XML parsing in `ProactiveSurface`. Already check if present in workspace. |
| `nanoid` | `^5.x` | Insight ID generation. Check workspace — likely already present. |

Note: `fast-xml-parser` may not be in the workspace yet. Lightweight alternative: parse the XML with a regex over `<failure` tags if adding a new dependency is undesirable. Document the trade-off.

---

## Acceptance Criteria

1. **Verification on server start**: `0agent run "make a server on port 3000"` → agent creates `server.js` and runs it → `ExecutionVerifier` performs HTTP check → CLI prints `Verified: HTTP 200 on :3000 (1.2s)`.

2. **Self-heal on server failure**: If the server crashes immediately (e.g., port already in use), `SelfHealLoop` re-runs the agent with the error context, the agent fixes the port conflict, server starts on :3001, verification passes. CLI prints `Healed (attempt 2/3): now running on :3001`.

3. **3-attempt limit respected**: If all 3 heal attempts fail, `AgentResult.heal_result.final_success === false`. CLI prints a clear failure message with the last error detail. No infinite loops.

4. **`0agent chat` greeting shows insights**: After a test failure is introduced (e.g., `echo "fail" >> src/index.test.ts`), within 60 seconds of the next `git commit`, opening `0agent chat` prints: `Since last session: 2 tests failing in src/index.test.ts`.

5. **Deep project scan runs automatically**: `0agent run "add a new endpoint"` — the agent's system prompt already contains the file structure map and the 3 hottest files. The agent creates the endpoint in the right directory without asking where to put it.

6. **WS events fire correctly**: A WebSocket client subscribed to the daemon receives `session.verify`, `session.heal_attempt` (if triggered), and `session.verified` events in correct order. Dashboard renders these events in the session trace view.

7. **Insights stored as SIGNAL nodes**: After a `ProactiveSurface` insight fires, `graph.queryByType(NodeType.SIGNAL)` returns at least one node with `metadata.insight_type = 'test_failure'`. The node has a `PRODUCES` edge from the user entity node.

8. **`GET /api/insights` returns unseen insights**: Calling the endpoint returns the `ProactiveInsight[]` for the current user. Calling `POST /api/insights/:id/seen` marks it seen. The next `GET` returns `seen: true` for that insight.

---

## Integration with Existing Phases

- **Phase Collab-1 (ProjectScanner)**: `DeepProjectScanner` calls `ProjectScanner.scan()` first, then appends deeper analysis. The 5-minute cache is shared — `DeepProjectScanner` extends the TTL key to include `"deep"` so shallow and deep results cache independently.

- **Phase 2 (BackgroundWorkers)**: `ProactiveSurface.poll()` is registered as a new worker in `BackgroundWorkers.start()`. It follows the same pattern as `decayScheduler` — a `setInterval` timer stored in `this.timers`, with status reported in `getStatus()`.

- **Phase 2 (WebSocketEventBus)**: The 4 new event types are added to the `DaemonEvent` union in `WebSocketEvents.ts`. The event bus `emit()` method works without modification — it accepts any `Record<string, unknown>`, so existing clients that don't know these event types will simply ignore them.

- **Phase 3 (KnowledgeGraph / NodeType.SIGNAL)**: `ProactiveSurface` uses `NodeType.SIGNAL` (already defined in `GraphNode.ts`) for insight nodes. It uses `createNode()` and `graph.addNode()` exactly as other components do. Insight nodes are linked to the user entity via `EdgeType.PRODUCES` edge.

- **Phase 5 (CompactionOrchestrator)**: SIGNAL nodes created by `ProactiveSurface` have `metadata.ttl_days = 7`. The `EdgePruner` (Phase 5) will naturally prune them after 7 days of no traversal. No special handling required.

---

## Risks and Gotchas

**Risk: `ExecutionVerifier` picks the wrong port.** Mitigation: If the agent output (the final `AgentResult.output` string) mentions a specific port number, parse it with a regex as a higher-confidence signal than command-line pattern matching. "Server started on port 4444" overrides the command-line heuristic.

**Risk: `SelfHealLoop` causes runaway token usage.** Mitigation: `HealResult.total_tokens` is tracked across all attempts. If it exceeds `3 * max_tokens_per_session` (configurable), the loop aborts and reports failure. This prevents a stuck agent from burning through API budget.

**Risk: Test output file parsing is fragile.** Mitigation: If JUnit XML parsing fails (malformed XML, unexpected format), fall back to looking for the words "FAIL", "FAILED", "Error:" in the raw file content. Log the parse failure but don't throw — insights are best-effort.

**Risk: `ProactiveSurface` polls even when no project is active.** Mitigation: `poll()` is a no-op if `lastKnownHead` is null (no git repo detected) or if the `cwd` doesn't exist. `BackgroundWorkers` passes the cwd from the daemon config; if none, polling is skipped.

**Risk: `DeepProjectScanner` `grep` for TODOs is slow on large repos.** Mitigation: Limit recursive grep to a depth of 3 (`--max-depth=3` for ripgrep or use Node's `fs.readdirSync` with a manual depth counter). Exclude `node_modules`, `.git`, `dist`, `build`, `target` directories explicitly. Total grep timeout: 3000ms.

**Risk: Self-heal context grows too large for LLM context window.** Mitigation: Truncate `last agent output excerpt` to 800 chars. Truncate `commands_run` to last 5 commands. The injected error context must not exceed ~500 tokens. Enforce this with a character limit check before injection.
