# Phase 2: Daemon + MCP (Weeks 5–7)

## Goal

Stand up the long-running daemon process on port 4200, wire in background workers (decay, deferred-trace resolver, compactor, enrichment poller), expose a REST + WebSocket API, implement MCP client/server mode with auto-discovery, and deliver a Rust CLI with the full command set. By end of phase, `0agent init` completes onboarding, `0agent run "hello"` streams output, and the daemon is stable enough for manual use.

Phase 2 has no new learning algorithms — it is entirely plumbing and interfaces. Every new module delegates to `@0agent/core` for graph operations.

---

## Complete File List

### packages/daemon
| File | Responsibility |
|------|---------------|
| `package.json` | `@0agent/daemon`, deps: hono, @hono/node-server, ws, @0agent/core, @0agent/mcp-hub |
| `tsconfig.json` | Extends tsconfig.base |
| `src/ZeroAgentDaemon.ts` | Main orchestrator: startup sequence, shutdown, wires all subsystems |
| `src/HTTPServer.ts` | Hono app: mounts all REST routes + WebSocket upgrade |
| `src/routes/sessions.ts` | Session CRUD routes |
| `src/routes/graph.ts` | Graph query routes |
| `src/routes/entities.ts` | Entity routes |
| `src/routes/traces.ts` | Trace routes |
| `src/routes/subagents.ts` | Subagent monitor routes |
| `src/routes/health.ts` | Health + stats route |
| `src/WebSocketEvents.ts` | EventEmitter-based broadcast bus, WS client registry |
| `src/SessionManager.ts` | Create/list/cancel sessions, trace lifecycle, concurrent session map |
| `src/BackgroundWorkers.ts` | Register + run: decay, deferred resolver, compactor, enrichment |
| `src/config/DaemonConfig.ts` | Load ~/.0agent/config.yaml, schema validation with zod |
| `src/config/ConfigSchema.ts` | Zod schemas for all config sections |
| `src/SkillRegistry.ts` | Loads skill YAMLs from `skills/` (built-in) and `~/.0agent/skills/` (user), caches them, provides `get(name)`, `list()`, `toCapabilityToken(skill, context)` |
| `src/SkillVariableResolver.ts` | Resolves $PROJECT_DIR, $CURRENT_PROJECT, $MENTIONED_ENTITIES, $LATEST_ARTIFACT:type, $ARG_* variables in skill YAML fields |
| `src/routes/skills.ts` | Skill CRUD routes: list, show, create custom, remove custom |

### packages/core (new files added in Phase 2)
| File | Responsibility |
|------|---------------|
| `src/types/SkillDefinition.ts` | TypeScript interfaces for parsed skill YAML: SkillDefinition, SkillArg, SkillSubagentProfile, SkillOutcome |
| `src/engine/InferenceEngine.ts` | Minimal stub: takes task string, queries NodeResolutionService + KnowledgeGraph.queryMerged, runs SelectionPolicy.select, returns selected plan. No subagent delegation (Phase 3), no attribution (Phase 4). Lives in core but wired up by the daemon. |

### packages/mcp-hub
| File | Responsibility |
|------|---------------|
| `package.json` | `@0agent/mcp-hub`, deps: @modelcontextprotocol/sdk, @0agent/core |
| `tsconfig.json` | Extends tsconfig.base |
| `src/MCPHub.ts` | Dual-mode: client (connects to remote MCP servers) + server (exposes 0agent) |
| `src/MCPDiscovery.ts` | Scan CWD for .mcp.json, .0agent/mcp.yaml, .cursor/mcp.json, package.json |
| `src/FilteredProxy.ts` | Re-exposes MCP tools filtered by capability token allowed_tools list |
| `src/builtin/BrowserMCP.ts` | Browser automation: navigate, snapshot, click, fill, screenshot, extract |
| `src/builtin/FilesystemMCP.ts` | File tools: read_file, write_file, list_dir, search_files (scoped) |
| `src/builtin/ShellMCP.ts` | Shell: execute_command (sandboxed, timeout-enforced) |
| `src/builtin/MemoryMCP.ts` | Graph tools: query_graph, get_entity, search_nodes (read-only) |
| `src/types.ts` | Shared MCP types: MCPServerConfig, MCPToolDef, MCPCallResult |

### packages/cli
| File | Responsibility |
|------|---------------|
| `Cargo.toml` | `zero-agent-cli`, deps: clap, reqwest, tokio, serde, serde_json, colored, indicatif, dialoguer, config |
| `src/main.rs` | Clap root command, subcommand dispatch |
| `src/commands/init.rs` | 5-step interactive onboarding wizard |
| `src/commands/run.rs` | Submit task, stream output via SSE or WS |
| `src/commands/chat.rs` | Interactive REPL: prompt → run → print loop |
| `src/commands/graph.rs` | `query`, `export`, `rollback` subcommands |
| `src/commands/entity.rs` | `list`, `show` subcommands |
| `src/commands/trace.rs` | `list`, `show` subcommands |
| `src/commands/debug.rs` | Low-level: raw graph dump, HNSW stats |
| `src/commands/config.rs` | `model add`, `embedding set`, `sandbox set` |
| `src/commands/skill.rs` | `list`, `show <name>`, `create <name>`, `edit <name>`, `remove <name>` subcommands |
| `src/commands/workflow.rs` | `show` (display workflow graph), `suggest` (recommend next skill based on graph state) |
| `src/commands/service.rs` | Install/remove systemd or launchd service |
| `src/commands/start.rs` | Spawn daemon process, write PID file |
| `src/commands/stop.rs` | Read PID file, send SIGTERM |
| `src/commands/status.rs` | GET /api/health, pretty-print |
| `src/commands/logs.rs` | Tail ~/.0agent/logs/daemon.log [--subagent <id>] |
| `src/api_client.rs` | Typed Rust client wrapping reqwest: all REST + WS calls |
| `src/config.rs` | Read ~/.0agent/config.yaml into Config struct |
| `src/output.rs` | Colored pretty-printer helpers |

### skills/ (repo root — built-in skill YAMLs)
| File | Responsibility |
|------|---------------|
| `skills/*.yaml` (15 files) | Built-in skill definitions (e.g. review, plan, test, build, ship, etc.). Installed to `~/.0agent/skills/builtin/` during `0agent init`. |

### seeds/
| File | Responsibility |
|------|---------------|
| `seeds/software-engineering/sprint-workflow.json` | Pre-weighted graph with skill nodes and edges — the sprint workflow seed graph |

### install/
| File | Responsibility |
|------|---------------|
| `install/install.sh` | One-line installer: download CLI binary, run `0agent init` |
| `install/templates/systemd.service` | systemd unit template (substitutes paths) |
| `install/templates/launchd.plist` | macOS LaunchAgent plist template |

### ~/.0agent/ (created by init, not in repo)
```
~/.0agent/
  config.yaml          — main config (LLM keys, sandbox, MCP servers)
  graph.db             — SQLite graph database
  hnsw.bin             — HNSW index mmap file
  object_store/        — screenshots, archives, file artifacts
  logs/
    daemon.log
    daemon.pid
  skills/
    builtin/           — 15 built-in skill YAMLs (installed by init)
    custom/            — user-created skill YAMLs
  seeds/               — installed seed graph packages
```

---

## Key Interfaces and Types

```typescript
// packages/core/src/types/SkillDefinition.ts
export interface SkillDefinition {
  name: string;
  description: string;
  trigger: string;
  category: 'think' | 'plan' | 'build' | 'review' | 'test' | 'ship' | 'reflect' | 'utility';
  args: SkillArg[];
  subagent: SkillSubagentProfile;
  workflow: { follows: string[]; feeds_into: string[] };
  output: { format: string; artifacts: string[]; saves_to: string | null };
  outcome: SkillOutcome;
  role_prompt: string;
}

export interface SkillArg {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'string[]';
  required: boolean;
  default?: unknown;
  description: string;
}

export interface SkillSubagentProfile {
  model: string;              // e.g. "default", "fast", or a specific model id
  tools: string[];            // MCP tool names to allow
  max_steps: number;
  timeout_ms: number;
  sandbox: boolean;
}

export interface SkillOutcome {
  success_signal: string;     // how to detect success (e.g. "exit_code:0", "artifact_exists")
  failure_signal: string;     // how to detect failure
  weight_on_success: number;  // weight delta to apply on success
  weight_on_failure: number;  // weight delta to apply on failure
}
```

```typescript
// packages/core/src/engine/InferenceEngine.ts
export interface IInferenceEngine {
  resolve(task: string, context?: Record<string, unknown>): Promise<InferencePlan>;
}

export interface InferencePlan {
  task: string;
  selected_nodes: string[];   // node IDs from knowledge graph
  skill?: string;             // matched skill name, if any
  confidence: number;         // 0–1 confidence from SelectionPolicy
  reasoning: string;          // human-readable explanation
}

// Minimal stub implementation: takes task string →
//   NodeResolutionService → KnowledgeGraph.queryMerged → SelectionPolicy.select →
//   returns selected plan.
// No subagent delegation (Phase 3), no attribution (Phase 4).
```

```typescript
// packages/daemon/src/ZeroAgentDaemon.ts
export interface DaemonStartupOptions {
  config_path: string       // default: ~/.0agent/config.yaml
  port: number              // default: 4200
  graph_db_path: string     // default: ~/.0agent/graph.db
  hnsw_path: string         // default: ~/.0agent/hnsw.bin
  log_path: string          // default: ~/.0agent/logs/daemon.log
}

export interface DaemonStatus {
  version: string
  uptime_ms: number
  graph_nodes: number
  graph_edges: number
  active_sessions: number
  sandbox_backend: string
  mcp_servers_connected: number
  workers_running: string[]
}
```

```typescript
// packages/daemon/src/SessionManager.ts
export interface Session {
  id: string
  task: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  created_at: number
  started_at?: number
  completed_at?: number
  result?: unknown
  error?: string
  trace_id?: string
  steps: SessionStep[]
}

export interface SessionStep {
  index: number
  description: string
  result?: unknown
  started_at: number
  completed_at?: number
}

export interface CreateSessionRequest {
  task: string
  skill?: string               // skill name — if set, load from SkillRegistry and use its role_prompt + tools
  context?: Record<string, unknown>
  options?: {
    max_steps?: number
    timeout_ms?: number
  }
}
```

```typescript
// packages/daemon/src/WebSocketEvents.ts
export type DaemonEvent =
  | { type: 'session.started',     session_id: string; task: string }
  | { type: 'session.step',        session_id: string; step: string; result: unknown }
  | { type: 'session.completed',   session_id: string; result: unknown }
  | { type: 'session.failed',      session_id: string; error: string }
  | { type: 'skill.started',       session_id: string; skill_name: string; args: Record<string, unknown> }
  | { type: 'skill.completed',     session_id: string; skill_name: string; duration_ms: number; artifacts: string[] }
  | { type: 'skill.failed',        session_id: string; skill_name: string; error: string }
  | { type: 'subagent.spawned',    subagent_id: string; tools: string[] }
  | { type: 'subagent.completed',  subagent_id: string; duration_ms: number }
  | { type: 'graph.weight_updated', edge_id: string; old: number; new: number }
  | { type: 'daemon.stats',        graph_nodes: number; active_sessions: number }

export interface IEventBus {
  emit(event: DaemonEvent): void
  subscribe(handler: (event: DaemonEvent) => void): () => void  // returns unsubscribe
}
```

```typescript
// packages/mcp-hub/src/MCPHub.ts
export interface MCPServerConfig {
  name: string
  command?: string        // for stdio transport
  args?: string[]
  url?: string            // for SSE/HTTP transport
  env?: Record<string, string>
  enabled: boolean
}

export interface MCPTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>  // JSON Schema
  server_name: string
}

export interface MCPCallResult {
  content: Array<{ type: 'text' | 'image'; text?: string; data?: string; mimeType?: string }>
  isError?: boolean
}
```

```typescript
// packages/mcp-hub/src/MCPDiscovery.ts
export interface DiscoveryResult {
  servers: MCPServerConfig[]
  source: '.mcp.json' | '.0agent/mcp.yaml' | '.cursor/mcp.json' | 'package.json'
  found_at: string   // absolute path
}
```

```typescript
// packages/daemon/src/config/ConfigSchema.ts
import { z } from 'zod'

export const LLMProviderSchema = z.object({
  provider: z.enum(['openai', 'anthropic', 'ollama', 'groq', 'gemini']),
  api_key: z.string().optional(),
  base_url: z.string().optional(),
  model: z.string(),
  is_default: z.boolean().default(false),
})

export const EmbeddingConfigSchema = z.object({
  provider: z.enum(['nomic-ollama', 'openai', 'ollama']),
  model: z.string().default('nomic-embed-text'),
  ollama_base_url: z.string().default('http://localhost:11434'),
  openai_api_key: z.string().optional(),
})

export const SandboxConfigSchema = z.object({
  backend: z.enum(['firecracker', 'docker', 'podman', 'bwrap', 'cloud', 'process']),
  e2b_api_key: z.string().optional(),
  memory_mb: z.number().default(512),
  cpus: z.number().default(1),
})

export const MCPServerEntrySchema = z.object({
  name: z.string(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
  env: z.record(z.string()).optional(),
  enabled: z.boolean().default(true),
})

export const DaemonConfigSchema = z.object({
  version: z.string().default('1'),
  llm_providers: z.array(LLMProviderSchema).min(1),
  embedding: EmbeddingConfigSchema,
  sandbox: SandboxConfigSchema,
  mcp_servers: z.array(MCPServerEntrySchema).default([]),
  server: z.object({
    port: z.number().default(4200),
    host: z.string().default('127.0.0.1'),
    bearer_token: z.string().optional(),
  }).default({}),
  graph: z.object({
    db_path: z.string(),
    hnsw_path: z.string(),
    object_store_path: z.string(),
  }),
  seed: z.string().optional(),  // e.g. "software-engineering"
})

export type DaemonConfig = z.infer<typeof DaemonConfigSchema>
```

---

## REST API — Route Implementations

### sessions.ts
```typescript
// POST /api/sessions
// Body: CreateSessionRequest
// Response: { session_id: string, status: 'pending' }

// GET /api/sessions
// Response: Session[]

// GET /api/sessions/:id
// Response: Session

// DELETE /api/sessions/:id
// Cancels: sets status='cancelled', emits session.failed event
```

### graph.ts
```typescript
// GET /api/graph/nodes?graph_id=&type=&limit=
// GET /api/graph/nodes/:id
// GET /api/graph/edges?from_node=&to_node=&type=
// POST /api/graph/query
// Body: { query: string, semantic?: boolean, limit?: number, graph_id?: string }
// Response: { nodes: GraphNode[], edges: GraphEdge[], semantic_scores?: number[] }
```

### skills.ts
```typescript
// GET /api/skills
// Response: SkillDefinition[] (all built-in + custom skills)

// GET /api/skills/:name
// Response: SkillDefinition (single skill by name)
// 404 if not found

// POST /api/skills
// Body: { name: string, yaml: string }
// Creates a custom skill in ~/.0agent/skills/custom/<name>.yaml
// Response: { ok: true, skill: SkillDefinition }
// 409 if name conflicts with built-in skill

// DELETE /api/skills/:name
// Removes a custom skill. Cannot delete built-in skills.
// Response: { ok: true }
// 403 if skill is built-in, 404 if not found
```

### health.ts
```typescript
// GET /api/health
// Response: DaemonStatus (see above)
// Also includes: { ok: true, timestamp: number }
```

---

## WebSocket Protocol

Endpoint: `ws://localhost:4200/ws`

```typescript
// Client sends: { type: 'subscribe', topics: string[] }
// Topics: 'sessions', 'graph', 'subagents', 'skills', 'stats'
// Server sends: DaemonEvent JSON (one per line)

// Stats heartbeat: every 30 seconds, server emits:
{ type: 'daemon.stats', graph_nodes: N, active_sessions: M }

// On weight update, emitted immediately:
{ type: 'graph.weight_updated', edge_id: 'xyz', old: 0.5, new: 0.63 }
```

---

## MCP Auto-Discovery Priority

```typescript
// MCPDiscovery.ts — scan in this exact order, stop at first found
async discover(cwd: string): Promise<DiscoveryResult[]> {
  const results: DiscoveryResult[] = []

  // 1. .mcp.json (Claude Desktop format)
  const mcpJson = path.join(cwd, '.mcp.json')
  if (existsSync(mcpJson)) {
    const data = JSON.parse(readFileSync(mcpJson, 'utf8'))
    // data.mcpServers: Record<string, { command, args, env }>
    results.push({ servers: parseMcpJson(data), source: '.mcp.json', found_at: mcpJson })
  }

  // 2. .0agent/mcp.yaml
  const agentYaml = path.join(cwd, '.0agent', 'mcp.yaml')
  if (existsSync(agentYaml)) { /* parse YAML */ }

  // 3. .cursor/mcp.json
  const cursorJson = path.join(cwd, '.cursor', 'mcp.json')
  if (existsSync(cursorJson)) { /* same format as .mcp.json */ }

  // 4. package.json → "mcpServers" field
  const pkgJson = path.join(cwd, 'package.json')
  if (existsSync(pkgJson)) {
    const pkg = JSON.parse(readFileSync(pkgJson, 'utf8'))
    if (pkg.mcpServers) { /* parse */ }
  }

  return results
  // Caller merges results, later sources do not override earlier ones for same server name
}
```

## MCP Server Mode (0agent exposes itself)

```typescript
// MCPHub.ts — server mode
// Exposed tools:
const SERVER_TOOLS: MCPTool[] = [
  {
    name: 'query_graph',
    description: 'Query the knowledge graph with a natural language or structured query',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number', default: 10 }
      },
      required: ['query']
    }
  },
  {
    name: 'run_task',
    description: 'Submit a task to 0agent for execution',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string' },
        context: { type: 'object' }
      },
      required: ['task']
    }
  },
  {
    name: 'get_entity',
    description: 'Get an entity and its subgraph summary',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id']
    }
  },
  {
    name: 'search_nodes',
    description: 'Semantic search over graph nodes',
    inputSchema: {
      type: 'object',
      properties: {
        embedding_query: { type: 'string' },
        limit: { type: 'number', default: 10 }
      },
      required: ['embedding_query']
    }
  }
]
```

---

## Onboarding Wizard — init command

```rust
// packages/cli/src/commands/init.rs
// 5-step interactive wizard using dialoguer

// Step 1: LLM Provider
// - Select provider: OpenAI / Anthropic / Ollama / Groq / Gemini
// - Enter API key (hidden input for cloud providers)
// - Validate: make a test API call (e.g., simple completion)
// - Save to config

// Step 2: Embedding model
// - Option A: Local (Nomic via Ollama) — check if ollama is running
//   - If ollama not found: offer to install, or skip with warning
// - Option B: Cloud (OpenAI text-embedding-3-small)
//   - Requires OpenAI API key (reuse from step 1 if applicable)

// Step 3: Sandbox backend
// - Auto-detect in priority order: Firecracker → Docker → Podman → bwrap → Cloud → Process
// - Show detected backend, allow override
// - For Cloud: prompt for E2B API key

// Step 4: MCP tool connections
// - Scan CWD for .mcp.json, .cursor/mcp.json, package.json mcpServers
// - Display found servers, ask which to enable
// - Offer common ones: "Browser (built-in)", "Filesystem (built-in)", "Shell (built-in)"

// Step 5: Seed graph
// - Select: software-engineering / research / b2b-outbound / scratch / import from file
// - scratch: empty graph
// - import: path to JSON export

// Post-wizard:
// - Write ~/.0agent/config.yaml
// - Create ~/.0agent/ directory structure
// - Run `0agent start` (start daemon)
// - Print "0agent is ready. Run: 0agent run \"your task\""
```

---

## Daemon Startup Sequence

```typescript
// ZeroAgentDaemon.ts
async start(opts: DaemonStartupOptions): Promise<void> {
  // 1. Load and validate config
  const config = await DaemonConfig.load(opts.config_path)

  // 2. Open SQLite database
  const adapter = new SQLiteAdapter({ db_path: config.graph.db_path, wal_mode: true, busy_timeout_ms: 5000 })

  // 3. Open or create HNSW index
  const hnsw = new HNSWIndex(config.graph.hnsw_path)

  // 4. Initialize KnowledgeGraph
  const graph = new KnowledgeGraph(adapter, hnsw)

  // 5. Initialize embedding (lazy — only connect when first needed)
  const embedder = MultimodalEmbedder.fromConfig(config.embedding)

  // 6. Start MCP Hub (discovery + connect to configured servers)
  const mcpHub = new MCPHub(config.mcp_servers)
  await mcpHub.connectAll()

  // 6.5. Load skill registry
  const skillRegistry = new SkillRegistry(config)
  await skillRegistry.loadAll()  // loads from skills/ (built-in) + ~/.0agent/skills/ (user)

  // 6.6. Initialize InferenceEngine stub
  const resolver = new NodeResolutionService(graph, embedder)
  const policy = new SelectionPolicy(graph)
  const inferenceEngine = new InferenceEngine(graph, resolver, policy)

  // 7. Start session manager
  const sessions = new SessionManager(graph, mcpHub, skillRegistry, inferenceEngine, config)

  // 8. Start background workers
  const workers = new BackgroundWorkers({ graph, config })
  workers.start()

  // 9. Start WebSocket event bus
  const eventBus = new WebSocketEventBus()

  // 10. Start HTTP server
  const server = new HTTPServer({ port: opts.port, sessions, graph, eventBus, mcpHub })
  await server.start()

  // 11. Write PID file
  writeFileSync(`${opts.log_path}/../daemon.pid`, String(process.pid))

  // 12. Log startup
  console.log(`0agent daemon started on port ${opts.port}`)

  // Graceful shutdown on SIGTERM/SIGINT
  process.on('SIGTERM', () => this.stop())
  process.on('SIGINT',  () => this.stop())
}

async stop(): Promise<void> {
  // Drain active sessions (wait up to 30s)
  // Stop background workers
  // Close MCP connections
  // Close HTTP server
  // Close SQLite
  // Remove PID file
}
```

---

## Background Workers

```typescript
// BackgroundWorkers.ts

interface WorkerConfig {
  decay_interval_ms: number        // 6 * 60 * 60 * 1000 (6h)
  deferred_check_interval_ms: number  // 60 * 1000 (1 min)
  compactor_interval_ms: number    // 24 * 60 * 60 * 1000 (24h) — Phase 5 full impl
  enrichment_interval_ms: number   // 15 * 60 * 1000 (15 min) — Phase 4 full impl
}

// Phase 2 implements: decay scheduler + deferred trace resolver
// Phase 4 implements: enrichment poller
// Phase 5 implements: compactor

class BackgroundWorkers {
  private timers: NodeJS.Timeout[] = []

  start(): void {
    // Decay worker
    this.timers.push(setInterval(async () => {
      await this.decayScheduler.runCycle(this.graph)
    }, this.config.decay_interval_ms))

    // Deferred trace resolver (stub for now — full impl Phase 4)
    this.timers.push(setInterval(async () => {
      await this.resolveDeferred()
    }, this.config.deferred_check_interval_ms))
  }

  stop(): void {
    this.timers.forEach(t => clearInterval(t))
    this.timers = []
  }

  private async resolveDeferred(): Promise<void> {
    // In Phase 2: only expire TTL'd deferred traces (assign signal 0.0)
    // Full resolution logic implemented in Phase 4
    const expired = this.traceStore.getExpiredDeferred(Date.now())
    for (const trace of expired) {
      await this.traceStore.resolve(trace.id, 0.0, 'expired')
    }
  }
}
```

---

## CLI Command Reference

```rust
// main.rs clap structure
#[derive(Parser)]
#[command(name = "0agent", version, about = "0agent CLI")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    Init,
    Start,
    Stop,
    Status,
    Run {
        task: String,
        #[arg(long)] no_stream: bool,
        #[arg(long)] skill: Option<String>,  // --skill review
    },
    Chat,
    Skill {
        #[command(subcommand)]
        cmd: SkillCommands,  // list, show, create, edit, remove
    },
    Workflow {
        #[command(subcommand)]
        cmd: WorkflowCommands,  // show, suggest
    },
    Graph {
        #[command(subcommand)]
        cmd: GraphCommands,
    },
    Entity {
        #[command(subcommand)]
        cmd: EntityCommands,
    },
    Trace {
        #[command(subcommand)]
        cmd: TraceCommands,
    },
    Debug,
    Config {
        #[command(subcommand)]
        cmd: ConfigCommands,
    },
    Service {
        #[command(subcommand)]
        cmd: ServiceCommands,
    },
    Logs {
        #[arg(long)]
        subagent: Option<String>,
        #[arg(long, default_value = "100")]
        lines: usize,
    },
}
```

### Slash Command Rewriting (main.rs)

If the first CLI argument starts with `/`, it is rewritten to `run --skill`. This allows shorthand invocation of skills:

```rust
// 0agent /review        → 0agent run --skill review
// 0agent /plan "sprint" → 0agent run --skill plan "sprint"
// 0agent /test          → 0agent run --skill test

fn rewrite_slash_commands(args: &mut Vec<String>) {
    if args.len() > 1 && args[1].starts_with('/') {
        let skill_name = args[1][1..].to_string();
        args[1] = "run".to_string();
        args.insert(2, "--skill".to_string());
        args.insert(3, skill_name);
    }
}
```

### run.rs — Task Streaming

```rust
// 0agent run "<task>"
// 1. POST /api/sessions with task
// 2. Open WS to ws://localhost:4200/ws
// 3. Subscribe to session events for session_id
// 4. Print steps as they arrive (colored output)
// 5. On session.completed or session.failed: exit

// Stream format (colored terminal output):
// [step 1] Resolving entities...
// [step 2] Querying knowledge graph...
// [step 3] Spawning subagent: web_research
// ✓ Completed in 4.2s
```

---

## Skill Library Integration

The skill library gives 0agent a structured vocabulary of reusable actions. Skills are declarative YAML files that define what a subagent does, which tools it gets, and how it fits into a workflow graph.

### Architecture

1. **Skill YAMLs** — Each skill is a single YAML file with fields matching `SkillDefinition`. Built-in skills ship in the `skills/` directory at the repo root (15 files). User-created skills live in `~/.0agent/skills/custom/`.

2. **SkillRegistry** (`packages/daemon/src/SkillRegistry.ts`, ~80 lines) — On daemon startup, loads all YAML files from `skills/` (built-in) and `~/.0agent/skills/` (user custom). Caches parsed `SkillDefinition` objects in a `Map<string, SkillDefinition>`. API:
   - `get(name: string): SkillDefinition | undefined`
   - `list(): SkillDefinition[]`
   - `toCapabilityToken(skill: SkillDefinition, context: Record<string, unknown>): CapabilityToken` — converts a skill into a capability token suitable for subagent spawning (Phase 3 will use the full token; Phase 2 returns a simplified version with `allowed_tools` from `skill.subagent.tools`).

3. **SkillVariableResolver** (`packages/daemon/src/SkillVariableResolver.ts`) — Before a skill YAML is executed, template variables in its fields are resolved:
   - `$PROJECT_DIR` — current working directory / project root
   - `$CURRENT_PROJECT` — project name from config or git remote
   - `$MENTIONED_ENTITIES` — entity IDs referenced in the user's task
   - `$LATEST_ARTIFACT:type` — path to most recent artifact of given type (e.g. `$LATEST_ARTIFACT:test-report`)
   - `$ARG_*` — maps to skill args (e.g. `$ARG_FILE` for a skill arg named `file`)

4. **Daemon handleRun extension** — When a `CreateSessionRequest` includes a `skill` field (or the CLI passes `--skill`), the `SessionManager`:
   1. Loads the skill from `SkillRegistry.get(name)`
   2. Resolves variables via `SkillVariableResolver`
   3. Converts to a `CapabilityToken` via `SkillRegistry.toCapabilityToken()`
   4. Spawns a subagent with `skill.role_prompt` as the system prompt (Phase 2 stub: runs a single LLM call with the role prompt; Phase 3 wires in the full `SubagentOrchestrator`)

5. **Onboarding wizard Step 5 update** — When the user picks the "software-engineering" seed, the wizard also:
   - Copies the 15 built-in skill YAMLs to `~/.0agent/skills/builtin/`
   - Installs the sprint workflow seed graph from `seeds/software-engineering/sprint-workflow.json`

6. **Sprint workflow seed graph** (`seeds/software-engineering/sprint-workflow.json`) — A pre-weighted knowledge graph fragment with:
   - Nodes for each of the 15 built-in skills
   - Edges encoding workflow ordering (e.g. `plan → build`, `build → test`, `test → review`, `review → ship`)
   - Initial weights reflecting typical software engineering workflows

### InferenceEngine Stub

`packages/core/src/engine/InferenceEngine.ts` is the minimal planning engine wired up in Phase 2:

```typescript
class InferenceEngine implements IInferenceEngine {
  constructor(
    private graph: KnowledgeGraph,
    private resolver: NodeResolutionService,
    private policy: SelectionPolicy,
  ) {}

  async resolve(task: string, context?: Record<string, unknown>): Promise<InferencePlan> {
    // 1. Resolve task to candidate nodes via NodeResolutionService
    const candidates = await this.resolver.resolve(task);

    // 2. Query merged subgraph for context
    const subgraph = await this.graph.queryMerged(candidates.map(c => c.id));

    // 3. Run selection policy to pick the best plan
    const selected = await this.policy.select(candidates, subgraph, context);

    // 4. Return plan (no subagent delegation — that's Phase 3)
    return {
      task,
      selected_nodes: selected.nodes.map(n => n.id),
      skill: selected.matched_skill ?? undefined,
      confidence: selected.confidence,
      reasoning: selected.reasoning,
    };
  }
}
```

The daemon wires this up during startup (step 4.5 in the startup sequence) by constructing `InferenceEngine` with the graph, resolver, and policy from `@0agent/core`. `SessionManager` calls `InferenceEngine.resolve()` before executing a session.

---

## Implementation Order

### Week 5 (Days 1–5): Config + Daemon Core

1. **Day 1**: `packages/daemon` package setup, `DaemonConfig.ts` + `ConfigSchema.ts` with full zod validation. Write config load test.
2. **Day 2**: `SQLiteAdapter` from Phase 1 is imported — wire up `ZeroAgentDaemon.ts` startup skeleton (no HTTP yet). Test that graph opens correctly.
3. **Day 3**: `BackgroundWorkers.ts` — decay timer + deferred resolver stub. Test timers fire.
4. **Day 4**: `SessionManager.ts` — in-memory session map, CRUD, status transitions.
5. **Day 5**: `WebSocketEvents.ts` — EventEmitter bus, WS upgrade handler.

### Week 6 (Days 6–10): HTTP + MCP Hub

6. **Day 6**: `HTTPServer.ts` with Hono — mount health route first, verify port 4200 responds.
7. **Day 7**: Mount session routes + graph routes.
8. **Day 8**: `packages/mcp-hub` setup — `MCPDiscovery.ts` (file scanning, no actual MCP connections yet).
9. **Day 9**: `MCPHub.ts` client mode — connect to a test stdio MCP server, list tools.
10. **Day 10**: `FilteredProxy.ts` (stub — no capability tokens yet, full impl Phase 3). Builtin MCPs (FilesystemMCP, ShellMCP stubs).

### Week 7 (Days 11–15): CLI + Integration

11. **Day 11**: `packages/cli` Cargo setup, clap structure, `api_client.rs` with all route types.
12. **Day 12**: `status.rs`, `start.rs`, `stop.rs` commands.
13. **Day 13**: `init.rs` — wizard (can mock sandbox detection in tests, real detection in prod).
14. **Day 14**: `run.rs` + `chat.rs` with WS streaming.
15. **Day 15**: `service.rs` (systemd + launchd templates), `install.sh`.

---

## External Dependencies

### packages/daemon
```json
{
  "dependencies": {
    "hono": "^4.2.0",
    "@hono/node-server": "^1.9.0",
    "ws": "^8.16.0",
    "yaml": "^2.4.0",
    "zod": "^3.22.4",
    "@0agent/core": "workspace:*",
    "@0agent/mcp-hub": "workspace:*"
  },
  "devDependencies": {
    "@types/ws": "^8.5.10",
    "vitest": "^1.4.0"
  }
}
```

### packages/mcp-hub
```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^0.6.0",
    "yaml": "^2.4.0",
    "@0agent/core": "workspace:*"
  }
}
```

### packages/cli (Cargo.toml)
```toml
[dependencies]
clap = { version = "4", features = ["derive"] }
tokio = { version = "1", features = ["full"] }
reqwest = { version = "0.12", features = ["json", "stream"] }
tokio-tungstenite = "0.21"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
colored = "2"
indicatif = "0.17"
dialoguer = "0.11"
config = "0.14"
dirs = "5"
anyhow = "1"
```

---

## Acceptance Criteria (Testable)

1. **Install**: `npx 0agent@latest` or `0agent init` launches 5-step wizard, completes, creates `~/.0agent/config.yaml`.
2. **Daemon start**: `0agent start` → daemon pid appears in `~/.0agent/daemon.pid`, port 4200 open.
3. **Health**: `GET /api/health` returns `{ ok: true, graph_nodes: N, ... }` with HTTP 200.
4. **Run + stream**: `0agent run "hello"` → POST /api/sessions succeeds, WS events arrive, output printed.
5. **Session lifecycle**: Create session → GET /api/sessions/:id shows 'running' → complete → 'completed'.
6. **WebSocket**: Open WS connection, submit session, receive `session.started` → `session.step` events → `session.completed`.
7. **MCP discovery**: Create `.mcp.json` in test dir, run `MCPDiscovery.discover(testDir)` → returns parsed server config.
8. **MCP client**: Connect to a test MCP server (use Filesystem MCP with a temp dir), `mcpHub.callTool('read_file', {...})` returns content.
9. **Background workers**: Decay worker logs activity every 6 simulated hours (use short interval in test mode).
10. **`0agent status`**: Shows uptime, graph size, sandbox backend, active sessions.
11. **`0agent stop`**: Sends SIGTERM, daemon stops, PID file removed.
12. **Config validation**: Invalid config.yaml (missing llm_providers) → daemon refuses to start with clear error message.
13. **WS stats heartbeat**: Every 30 seconds, `daemon.stats` event emitted to all WS subscribers.
14. **Skill list**: `0agent skill list` → shows all 15 built-in skills and any custom skills, with name, category, and description.
15. **Skill show**: `0agent skill show review` → prints full skill definition including trigger, args, workflow edges, and role_prompt.
16. **Skill run**: `0agent /review` rewrites to `0agent run --skill review` → session uses the review skill's role_prompt, allowed tools, and timeout.
17. **Skill CRUD API**: `POST /api/skills` with valid YAML → creates `~/.0agent/skills/custom/<name>.yaml`. `DELETE /api/skills/:name` removes it. Cannot delete built-in skills (returns 403).
18. **Skill variable resolution**: Skill with `$PROJECT_DIR` in role_prompt → resolved to actual CWD before execution.
19. **Skill WS events**: Running a skill emits `skill.started`, then `skill.completed` (or `skill.failed`) alongside normal session events.
20. **Workflow show**: `0agent workflow show` → prints the skill workflow graph (nodes and edges) from the sprint seed.
21. **Workflow suggest**: `0agent workflow suggest` → given current graph state, recommends the next skill to run.
22. **InferenceEngine stub**: `InferenceEngine.resolve("write tests")` → returns an `InferencePlan` with matched skill "test", selected nodes, and confidence score.
23. **Onboarding seeds + skills**: Selecting "software-engineering" in init wizard installs 15 built-in skills to `~/.0agent/skills/builtin/` and the sprint workflow seed graph.

---

## Risks and Gotchas

1. **Hono vs Express for Bun** — Hono is the right choice for Bun (native Bun adapter). Use `@hono/node-server` for Node.js fallback. Do NOT use Express — it has no Bun adapter and adds overhead. Hono's WebSocket support uses the upgrade handler: `app.get('/ws', upgradeWebSocket(...))`.

2. **MCP SDK version** — The `@modelcontextprotocol/sdk` package is evolving. Pin to `^0.6.0`. The `StdioClientTransport` and `SSEClientTransport` constructors changed between 0.5 and 0.6. Use the `Client` class's `connect(transport)` pattern.

3. **Rust CLI binary distribution** — The CLI must be a single static binary or have minimal dependencies. Use `cargo build --release --target x86_64-unknown-linux-musl` for Linux. For macOS: standard release build. The install script should detect platform and download the right binary from GitHub releases.

4. **Daemon as a separate process** — `0agent start` must daemonize properly on both Linux and macOS. On Linux: use double-fork or systemd. On macOS: use launchd or nohup. The simplest approach is: `nohup 0agent daemon &` with stdout/stderr redirected to log file. The `start.rs` command should use `std::process::Command::new("0agent").arg("daemon").spawn()`.

5. **WS reconnection** — The CLI `run` command uses WebSocket. If the daemon is slow to start, the WS connection may fail. Implement a 3-retry connect with 500ms backoff in `api_client.rs`.

6. **Config file location** — Use `dirs::home_dir()` in Rust (`dirs` crate) and `os.homedir()` in TypeScript. Always resolve `~/.0agent/` to absolute path at startup. Never assume CWD.

7. **Port conflict** — Before starting on port 4200, check if it's already in use. If it is, check if it's the daemon (GET /health) and if so, skip start. If not the daemon: error and suggest `--port`.

8. **Circular imports** — `@0agent/mcp-hub` imports from `@0agent/core` (for graph read tools in MemoryMCP). `@0agent/daemon` imports from both. Never have `@0agent/core` import from `@0agent/daemon` or `@0agent/mcp-hub`. Core must remain standalone.

9. **YAML vs JSON config** — Use YAML for `config.yaml` (human-readable). Use the `yaml` npm package. Comments in the config file are preserved. When rewriting config (e.g., after `0agent config model add`), preserve comments by doing surgical string replacement, not full re-serialize.

10. **Sandbox detection in init wizard** — Firecracker check is `access('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK)`. This throws on macOS. Wrap every sandbox detection in try/catch. On macOS, Firecracker is unavailable, Docker is the preferred backend.

11. **MCP FilteredProxy in Phase 2** — The full capability-token-based filtering is Phase 3. In Phase 2, implement `FilteredProxy` with a simple `allowed_tools: string[]` list (no HMAC yet). This lets us test MCP routing without subagent complexity.

---

## Integration Points with Other Phases

- **Phase 1 (Core)**: Daemon imports `KnowledgeGraph`, `WeightPropagation`, `DecayScheduler`, `TraceStore`, `WeightEventLog` from `@0agent/core`. All graph operations go through core. Phase 2 adds `SkillDefinition` types and `InferenceEngine` stub to core.
- **Phase 3 (Subagents)**: `SessionManager.runTask()` will delegate to `SubagentOrchestrator` (Phase 3). In Phase 2, sessions are stub-executed (LLM call without real subagent spawning). The session API shape must not change. Skills produce a simplified `CapabilityToken` in Phase 2; Phase 3 upgrades to HMAC-validated tokens with full `SubagentOrchestrator` integration.
- **Phase 3 (Subagents)**: `MCPHub.FilteredProxy` grows to accept `CapabilityToken` for HMAC-validated filtering. The stub in Phase 2 uses a plain `allowed_tools[]` array. `SkillRegistry.toCapabilityToken()` output feeds directly into Phase 3's token validation.
- **Phase 3 (Subagents)**: Skill `role_prompt` becomes the actual system prompt for spawned subagents. In Phase 2, it is passed as-is to a single LLM call; Phase 3 uses it with the full subagent lifecycle.
- **Phase 4 (Dashboard)**: The dashboard SvelteKit app is served as static files by the daemon HTTP server from the `GET /` route. In Phase 2, that route returns a placeholder page. Dashboard will visualize the skill workflow graph.
- **Phase 4 (Learning)**: `InferenceEngine` stub from Phase 2 is extended with attribution tracking, outcome-based weight updates, and richer selection policies. The `IInferenceEngine` interface remains stable.
- **Phase 5 (Compaction)**: Background workers in Phase 2 have stubs for compactor. Phase 5 fills them in by injecting `EdgePruner`, `SubgraphArchiver`, `NodeDeduplicator`.
