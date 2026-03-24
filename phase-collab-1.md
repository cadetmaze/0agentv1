# Phase Collab-1: "Know Me" — Identity + Context + Memory

## Goal

Every session starts with full context instead of a blank slate. The agent knows who you are (persistent identity), where you are (project stack, recent git activity), and what you were doing (conversation history). This phase transforms 0agent from a stateless executor into a personalized, context-aware assistant that requires zero re-introduction on every invocation.

This phase builds directly on the entity system from Phases 3-4 (PersonalityProfile, EntityHierarchy, EntityScopedContextLoader) and the SessionManager from Phase 2 — extending them rather than replacing them.

---

## Complete File List

### New files — packages/daemon/src/

| File | Responsibility |
|------|----------------|
| `src/IdentityManager.ts` | Loads `~/.0agent/identity.yaml` on startup; creates or resolves the user's entity node in KnowledgeGraph; builds `IdentityContext` injected into every session system prompt |
| `src/ProjectScanner.ts` | Scans the working directory before each task: detects stack (package.json, Cargo.toml, pyproject.toml), runs `git log --oneline -10`, checks `git status`, reads first 500 chars of README.md, probes common ports for running processes. Returns `ProjectContext`. |
| `src/SurfaceDetector.ts` | Determines the calling surface (terminal, Slack MCP, REST API, chat REPL). Formats agent responses differently per surface: terminal uses ANSI + concise output; Slack uses Markdown + emoji; API returns structured JSON; chat uses prose. |
| `src/ConversationStore.ts` | SQLite-backed conversation history per user entity. Stores last N (default 20) turns with timestamps. Loaded on `0agent chat` start. Provides `append()`, `load()`, `clear()` operations. |

### Modified files

| File | Change |
|------|--------|
| `bin/0agent.js` | `0agent init` extended: asks for name, writes `identity.yaml`. `0agent chat` loads conversation history before entering REPL loop. New `team` command dispatch stub for Phase Collab-3. |
| `packages/daemon/src/SessionManager.ts` | `runSession()` extended: calls `IdentityManager.buildIdentityContext()` and `ProjectScanner.scan()` before constructing the system prompt. Injects both into `AgentExecutor.execute()` via `systemContext`. |
| `packages/daemon/src/ZeroAgentDaemon.ts` | Startup step added between steps 2 and 3: initialize `IdentityManager`, call `identityManager.ensureUserEntityNode()`. Pass `IdentityManager` into `SessionManager`. |

### New files — ~/.0agent/

| File | Responsibility |
|------|----------------|
| `~/.0agent/identity.yaml` | Permanent user identity file. Written by `0agent init`. Never overwritten without explicit confirmation. Schema defined below. |
| `~/.0agent/conversations.db` | SQLite database for `ConversationStore`. Separate from the main `graph.db` so it can be cleared without touching the knowledge graph. |

---

## Key Interfaces and Types

```typescript
// packages/daemon/src/IdentityManager.ts

export interface UserIdentity {
  id: string;                // "usr_abc123" — permanent, generated once at init
  name: string;              // "Sahil Godara" — from 0agent init prompt
  entity_node_id: string;    // node ID in personal KnowledgeGraph — set after first ensureUserEntityNode()
  device_id: string;         // "macOS-Sahil-MBP" — os.hostname() + platform
  timezone: string;          // "Asia/Kolkata" — from Intl.DateTimeFormat().resolvedOptions()
  preferred_surface: 'terminal' | 'api' | 'slack' | 'chat';
  created_at: number;        // Unix ms — never changes
  version: number;           // schema version for migration — currently 1
}

export interface IdentityContext {
  user_name: string;
  entity_node_id: string;
  timezone: string;
  session_count: number;     // visit_count from entity node
  personality_prompt: string; // from PersonalityProfileStore (Phase 3)
  preferred_surface: string;
}
```

```typescript
// packages/daemon/src/ProjectScanner.ts

export interface ProjectContext {
  cwd: string;
  stack: string[];           // ["typescript", "node", "react"] — detected from manifest files
  package_name: string | null; // name field from package.json or Cargo.toml
  recent_commits: string[];  // last 10 one-line git log messages
  dirty_files: string[];     // uncommitted changes from git status --short
  running_ports: number[];   // ports 3000, 4200, 4201, 5173, 8080 with a listening process
  readme_summary: string;    // first 500 chars of README.md, or "" if absent
  open_todos: string[];      // up to 10 TODO/FIXME comments found in cwd (depth 2, common src dirs)
  is_git_repo: boolean;
  scanned_at: number;        // Unix ms — used for 5-minute cache invalidation
}

export interface ProjectScannerConfig {
  cwd: string;
  cache_ttl_ms?: number;     // default 300_000 (5 minutes)
  ports_to_probe?: number[]; // default [3000, 3001, 4200, 4201, 5173, 8080, 8000]
  readme_max_chars?: number; // default 500
}
```

```typescript
// packages/daemon/src/SurfaceDetector.ts

export type SurfaceType = 'terminal' | 'slack' | 'api' | 'chat';
export type FormatType  = 'ansi'     | 'markdown' | 'json' | 'prose';

export interface Surface {
  type: SurfaceType;
  format: FormatType;
  context: Record<string, string>; // slack: { workspace_id, channel_id }; api: { client_id }
}

export interface FormattedResponse {
  content: string;
  // For Slack: content is already markdown. For terminal: content has ANSI codes. For API: content is plain.
  metadata?: Record<string, unknown>;
}
```

```typescript
// packages/daemon/src/ConversationStore.ts

export interface ConversationTurn {
  id: string;           // nanoid
  entity_id: string;    // user entity node ID — allows per-user isolation
  role: 'user' | 'assistant';
  content: string;
  created_at: number;   // Unix ms
  session_id?: string;  // optional: links to a daemon session
  project_cwd?: string; // which project this turn happened in
}

export interface ConversationStoreConfig {
  db_path: string;      // default ~/.0agent/conversations.db
  max_history: number;  // default 20 turns loaded into context
}
```

---

## Implementation Order

### Step 1 — UserIdentity schema + IdentityManager (no graph dependency)
Build `IdentityManager` so it can load and write `identity.yaml` using `js-yaml`. The `ensureUserEntityNode()` method is a no-op if the graph is not yet available. This lets the file be tested in isolation.

### Step 2 — ConversationStore (SQLite, standalone)
Create the SQLite schema for `conversation_turns` table. Implement `append()` and `load(entityId, limit)`. Write unit tests with an in-memory SQLite database. This has no dependency on KnowledgeGraph.

### Step 3 — ProjectScanner (pure Node.js child_process + fs)
Implement stack detection logic (check file existence in priority order: `package.json` → `Cargo.toml` → `pyproject.toml` → `requirements.txt`). Run `git log` and `git status` via `execSync` with a 2000ms timeout — catch errors and return empty arrays when not a git repo. Port probing via `net.createConnection` with a 200ms timeout per port. Cache results in a `Map<string, { context: ProjectContext; expires_at: number }>`.

### Step 4 — SurfaceDetector
Detect surface from: HTTP request headers (presence of `X-Slack-Signature` → slack; `Accept: application/json` → api; process.stdout.isTTY → terminal; default → chat). Implement `format(response: string, surface: Surface): FormattedResponse` with per-surface renderers.

### Step 5 — Wire into ZeroAgentDaemon + SessionManager
Add `IdentityManager` initialization to `ZeroAgentDaemon.start()` between steps 2 and 3. Update `SessionManager` constructor to accept `IdentityManager` and `ProjectScanner`. Update `runSession()` to call both scanners and inject context into `systemContext` parameter passed to `AgentExecutor.execute()`.

### Step 6 — Update bin/0agent.js
Extend `runInit()` to prompt for name and write `identity.yaml`. Update `runChat()` to instantiate `ConversationStore`, load history, prepend it to the REPL context, and append each turn after completion.

### Step 7 — entity node visit_count increment
In `IdentityManager.ensureUserEntityNode()`: after resolving the node, call `graph.updateNode()` to increment `visit_count` and set `last_seen = Date.now()`. This is the mechanism that makes `session_count` accurate.

---

## Critical Algorithms

### Stack Detection Logic (ProjectScanner)

```typescript
// Priority order — first match wins for primary stack label
const STACK_DETECTORS: Array<{ file: string; stack: string[] }> = [
  { file: 'package.json',     stack: ['node'] },
  { file: 'Cargo.toml',       stack: ['rust'] },
  { file: 'pyproject.toml',   stack: ['python'] },
  { file: 'requirements.txt', stack: ['python'] },
  { file: 'go.mod',           stack: ['go'] },
  { file: 'build.gradle',     stack: ['java'] },
  { file: 'pom.xml',          stack: ['java', 'maven'] },
];

// Secondary refinements run on package.json `dependencies` + `devDependencies`
const FRAMEWORK_DEPS: Record<string, string> = {
  'react': 'react', 'next': 'nextjs', 'svelte': 'svelte',
  'express': 'express', 'fastify': 'fastify', 'hono': 'hono',
  'vite': 'vite', 'vitest': 'vitest', 'typescript': 'typescript',
};
```

### System Prompt Injection

`SessionManager.buildSystemPrompt(identity, project, surface)` returns a string prepended to the agent system prompt. Structure:

```
--- IDENTITY CONTEXT ---
You are working with {identity.user_name} (session #{identity.session_count}).
Timezone: {identity.timezone}. {identity.personality_prompt}

--- PROJECT CONTEXT ---
Working directory: {project.cwd}
Stack: {project.stack.join(', ')}
{project.package_name ? `Package: ${project.package_name}` : ''}
Recent commits: {project.recent_commits.slice(0,5).join(' | ')}
{project.dirty_files.length > 0 ? `Uncommitted changes: ${project.dirty_files.join(', ')}` : ''}
{project.running_ports.length > 0 ? `Running on ports: ${project.running_ports.join(', ')}` : ''}
{project.readme_summary ? `Project: ${project.readme_summary}` : ''}
--- END CONTEXT ---
```

### Port Probing (ProjectScanner)

```typescript
async function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host: '127.0.0.1' });
    socket.setTimeout(200);
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
  });
}
// Run all probes in parallel: Promise.all(PORTS.map(probePort))
```

### Conversation History Loading (ConversationStore)

Load the last `max_history` turns ordered by `created_at DESC`, then reverse to chronological order for injection into the LLM message array. This matches the `LLMMessage[]` format used by `LLMExecutor`.

```typescript
load(entityId: string, limit = 20): ConversationTurn[] {
  const rows = this.db.prepare(`
    SELECT * FROM conversation_turns
    WHERE entity_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(entityId, limit) as ConversationTurn[];
  return rows.reverse(); // chronological order for LLM context
}
```

---

## External Dependencies Needed

| Package | Version | Reason |
|---------|---------|--------|
| `js-yaml` | `^4.1.0` | Read/write `identity.yaml`. Already likely in monorepo via config loading — check `DaemonConfig.ts` first. |
| `better-sqlite3` | already used | `ConversationStore` needs a separate DB instance pointing to `~/.0agent/conversations.db` |
| `node:net` | built-in | Port probing in `ProjectScanner` |
| `node:os` | built-in | `os.hostname()` for `device_id` |
| `Intl.DateTimeFormat` | built-in | Timezone detection |

No new npm packages required if `js-yaml` is already in the workspace. Verify with `grep -r "js-yaml" packages/daemon/package.json`.

---

## Acceptance Criteria

1. **`0agent init` collects identity**: Running `0agent init` prompts `What's your name?`, writes `~/.0agent/identity.yaml` with all required fields. Re-running `0agent init` shows existing name and asks to confirm before overwriting.

2. **Every session injects identity context**: `0agent run "what am I working on?"` returns an answer that mentions the user's name, current project stack, and recent git commits — without the user providing any of this information.

3. **Conversation history persists across restarts**: Running `0agent chat`, asking "remember this: project is called Atlas", then exiting and re-running `0agent chat` — the agent opens with knowledge that the project is called Atlas (it appears in conversation history loaded from SQLite).

4. **Surface detection changes formatting**: A response to `curl -H "Accept: application/json" localhost:4200/api/sessions` returns JSON. The same request from `0agent run` in a terminal includes ANSI formatting. A Slack MCP request receives markdown with emoji.

5. **`0agent run "fix the failing test"` works without preamble**: Given a dirty git status with a failing test file, the agent's system prompt already contains the dirty file list — it proceeds directly to fixing without asking which test.

6. **User entity node visit_count increments**: After 3 separate `0agent run` invocations, `graph.getNode(identity.entity_node_id).visit_count` equals 3. Verifiable via `0agent status --json` or direct graph API call.

7. **ProjectScanner respects cache TTL**: Two `0agent run` invocations within 30 seconds result in only one `git log` subprocess execution (verified by adding a debug log or spy in tests).

---

## Integration with Existing Phases

- **Phase 1 (KnowledgeGraph)**: `IdentityManager.ensureUserEntityNode()` calls `graph.addNode()` using `NodeType.ENTITY` and `createNode()` from `GraphNode.ts`. The entity node ID stored in `identity.yaml` is the same node ID used by `EntityScopedContextLoader` (Phase 3).

- **Phase 3 (PersonalityProfile)**: `IdentityManager.buildIdentityContext()` calls `PersonalityProfileStore.get(entity_node_id)` to retrieve the accumulated personality prompt. The `personality_prompt` field in `IdentityContext` is populated from the existing `PersonalityProfile.communication_style` and `response_preferences` fields — no duplication.

- **Phase 4 (EntityScopedContext)**: `SessionManager.runSession()` already calls `EntityScopedContextLoader.load()`. The new `IdentityContext` is layered on top of this — identity context is prepended, entity scoped context (shared company nodes, parent entity labels) follows. Both are concatenated into the single `systemContext` string passed to `AgentExecutor.execute()`.

- **Phase 5 (SessionSnapshot / OCC)**: `ConversationStore` uses a separate SQLite database instance (`conversations.db`) to avoid interfering with the OCC session snapshot isolation on `graph.db`. The two databases share no schema.

---

## Risks and Gotchas

**Risk: `git log` and `git status` are slow on large repos.** Mitigation: run both commands with a hard 2000ms timeout via `execSync({ timeout: 2000 })`. On timeout, catch the exception and return empty arrays. The 5-minute cache prevents repeated subprocess spawning.

**Risk: `identity.yaml` entity_node_id refers to a deleted graph node.** Mitigation: `ensureUserEntityNode()` calls `graph.getNode(entity_node_id)` first — if null, creates a new node and updates `identity.yaml` with the new ID. This handles graph resets or migrations.

**Risk: Conversation history leaks between users on shared machines.** Mitigation: `ConversationStore` partitions by `entity_id` (the `usr_abc123` ID). The `load()` query always includes a `WHERE entity_id = ?` clause. This is enforced at the SQL layer, not just application logic.

**Risk: Port probing on restricted networks raises firewall alerts.** Mitigation: limit probes to loopback (`127.0.0.1`) only. Never probe external IPs. Probing is disabled entirely if `ProjectScannerConfig.ports_to_probe` is set to `[]`.

**Risk: `identity.yaml` written with wrong permissions.** Mitigation: write with `mode: 0o600` (owner read/write only) via `fs.writeFileSync(path, content, { mode: 0o600 })`.

**Risk: SurfaceDetector cannot detect Slack in all MCP configurations.** Mitigation: Slack MCP calls via `packages/mcp-hub` should inject an `X-0agent-Surface: slack` header when forwarding. `SurfaceDetector` checks for this header first before falling through to heuristics. Document this as a required convention in `mcp-hub/README`.
