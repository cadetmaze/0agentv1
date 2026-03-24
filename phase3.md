# Phase 3: Subagents + Sandbox (Weeks 8–11)

## Goal

Implement zero-trust subagent spawning: issue capability tokens (HMAC-SHA256 signed), detect and initialize sandbox backends (Firecracker → Docker → Podman → bwrap → Cloud → Process), inject the lightweight runtime inside the sandbox, enforce resource limits via watchdog, collect structured output, and destroy the sandbox — always, even on failure. By end of phase, a Docker subagent can navigate a URL, take a screenshot, and return the image artifact. Subagents are provably unable to write to the knowledge graph or spawn further subagents.

---

## Complete File List

### packages/subagent
| File | Responsibility |
|------|---------------|
| `package.json` | `@0agent/subagent`, deps: @0agent/core, @0agent/mcp-hub, uuid, zod |
| `tsconfig.json` | Extends tsconfig.base |
| `src/SubagentOrchestrator.ts` | Full lifecycle: issue token → create sandbox → inject → run → collect → destroy. **Skill mode**: when `SpawnRequest.skill` is set, inject the skill's `role_prompt` as the subagent system prompt and apply the skill's `subagent` profile as the CapabilityToken config |
| `src/SkillInvoker.ts` | Thin wrapper: takes a `SkillDefinition` + resolved args, converts to `SubagentRequest`, calls `SubagentOrchestrator.spawn()`. Handles skill-specific output parsing based on `output.format` (prose/json/markdown/diff) |
| `src/SkillInputResolver.ts` | Resolves runtime variables that depend on sandbox state — `$PROJECT_DIR` → sandbox filesystem scope, `$ARG_*` → user-provided args, `$LATEST_ARTIFACT:type` → reads from `.0agent/artifacts/` |
| `src/CapabilityToken.ts` | Token issue, HMAC-SHA256 sign, validate, expiry check |
| `src/Watchdog.ts` | Per-subagent timeout: kill sandbox after max_duration_ms |
| `src/ResourceDefaults.ts` | Default resource configs per task type |
| `src/SubagentResult.ts` | Result schema: output, artifacts, tool_calls, exit_reason |
| `src/sandbox/SandboxManager.ts` | Auto-detect backend, factory method, ISandboxBackend interface |
| `src/sandbox/FirecrackerBackend.ts` | microVM boot, vsock communication, snapshot restore |
| `src/sandbox/DockerBackend.ts` | `docker run` with resource limits, pipe communication |
| `src/sandbox/PodmanBackend.ts` | `podman run` rootless, same interface as Docker |
| `src/sandbox/BwrapBackend.ts` | bubblewrap namespaces, tmpfs, seccomp filter |
| `src/sandbox/CloudBackend.ts` | E2B API: create sandbox, exec, read output |
| `src/sandbox/ProcessBackend.ts` | Fork + seccomp-bpf (weakest isolation) |

### packages/subagent-runtime
| File | Responsibility |
|------|---------------|
| `package.json` | `@0agent/subagent-runtime`, minimal deps — runs INSIDE sandbox |
| `tsconfig.json` | Extends tsconfig.base, standalone bundle |
| `src/main.ts` | Entry point: read token + task from env/stdin, run agent loop, write output |
| `src/AgentLoop.ts` | LLM + tool call loop until completion or resource limit |
| `src/MCPProxy.ts` | Connect to parent's filtered MCP proxy, forward tool calls |
| `src/OutputChannel.ts` | Write structured JSON output to stdout/vsock/pipe |
| `src/TokenValidator.ts` | Verify HMAC signature on capability token at startup |
| `src/ResourceTracker.ts` | Count LLM calls, tokens, tool calls — enforce limits |

### packages/mcp-hub additions
| File | Responsibility |
|------|---------------|
| `src/builtin/BrowserMCP.ts` | Browser automation (navigate, snapshot, click, fill, screenshot, extract) |
| `src/FilteredProxy.ts` | UPDATED: full CapabilityToken-based filtering with HMAC validation |

### sandbox-images/
| File | Responsibility |
|------|---------------|
| `sandbox-images/ubuntu-minimal/Dockerfile` | Minimal Ubuntu + Node/Bun + runtime binary only |
| `sandbox-images/ubuntu-chrome/Dockerfile` | Extends minimal + Chromium + xvfb + noVNC for browser subagents |

### tests
| File | Responsibility |
|------|---------------|
| `tests/unit/subagent/capability_token.test.ts` | Issue, sign, validate, reject expired, reject tampered |
| `tests/unit/subagent/filtered_proxy.test.ts` | Block unlisted tools, allow listed, check HMAC |
| `tests/integration/sandbox_lifecycle.test.ts` | Docker sandbox: spawn → run echo → collect → destroy |
| `tests/integration/browser_sandbox.test.ts` | Browser subagent: navigate → screenshot → artifact returned |
| `tests/unit/subagent/skill_invoker.test.ts` | Skill → SubagentRequest conversion, output format parsing (prose/json/markdown/diff) |
| `tests/unit/subagent/skill_input_resolver.test.ts` | `$PROJECT_DIR`, `$ARG_*`, `$LATEST_ARTIFACT:type` resolution in sandbox context |
| `tests/integration/skill_chain.test.ts` | `/build` completes → auto-chain triggers `/review` when `workflow.auto_chain: true` |

---

## Key Interfaces and Types

```typescript
// src/CapabilityToken.ts — implement EXACTLY as specified

export interface GraphReadScope {
  mode: 'none' | 'entities' | 'context' | 'full_readonly'
  entity_ids: string[]
  context_types: NodeType[]
  max_depth: number
}

export interface SandboxConfig {
  type: 'firecracker' | 'docker' | 'podman' | 'bwrap' | 'cloud' | 'process'
  network_access: 'none' | 'allowlist' | 'full'
  network_allowlist?: string[]
  filesystem_access: 'none' | 'readonly' | 'scoped'
  filesystem_scope?: string
  has_browser: boolean
  has_display: boolean
}

export interface CapabilityToken {
  id: string
  subagent_id: string
  parent_session_id: string
  issued_at: number
  expires_at: number
  trust_level: 1 | 2
  allowed_tools: string[]
  blocked_tools: string[]
  graph_read: GraphReadScope
  graph_write: false          // ALWAYS false — never true
  allowed_credentials: string[]
  max_duration_ms: number
  max_llm_calls: number
  max_llm_tokens: number
  max_tool_calls: number
  sandbox: SandboxConfig
  signature: string           // HMAC-SHA256(JSON.stringify(token sans signature), DAEMON_SECRET)
}

export interface TokenIssueRequest {
  subagent_id: string
  parent_session_id: string
  task_type: TaskType
  graph_read_scope?: Partial<GraphReadScope>
  extra_tools?: string[]
  override_duration_ms?: number
}

export type TaskType =
  | 'web_research'
  | 'code_execution'
  | 'browser_task'
  | 'file_editing'
  | 'send_message'
```

```typescript
// src/SubagentResult.ts
export interface SubagentArtifact {
  id: string
  type: 'screenshot' | 'file' | 'text' | 'structured'
  content: string           // base64 for binary, raw string for text/JSON
  mime_type: string
  filename?: string
  created_at: number
}

export interface SubagentResult {
  subagent_id: string
  session_id: string
  task: string
  output: string            // final text output
  artifacts: SubagentArtifact[]
  tool_calls: ToolCallRecord[]
  llm_calls_used: number
  tokens_used: number
  tool_calls_count: number
  exit_reason: 'completed' | 'timeout' | 'resource_limit' | 'error' | 'killed'
  duration_ms: number
  error?: string
}

export interface ToolCallRecord {
  tool_name: string
  input: Record<string, unknown>
  output_summary: string
  duration_ms: number
  timestamp: number
}
```

```typescript
// src/sandbox/SandboxManager.ts
export interface ISandboxBackend {
  readonly type: SandboxConfig['type']
  isAvailable(): Promise<boolean>
  create(config: SandboxCreateConfig): Promise<SandboxHandle>
  destroy(handle: SandboxHandle): Promise<void>
}

export interface SandboxCreateConfig {
  image?: string               // Docker/Podman image name
  memory_mb: number
  cpus: number
  network: SandboxConfig['network_access']
  network_allowlist?: string[]
  has_browser: boolean
  has_display: boolean
  env: Record<string, string>
  inject_files: InjectedFile[]  // files to write into sandbox before start
}

export interface InjectedFile {
  path: string                  // absolute path inside sandbox
  content: string               // base64 or raw string
  mode?: number                 // unix permissions, default 0o644
}

export interface SandboxHandle {
  id: string
  backend_type: SandboxConfig['type']
  created_at: number
  // Communication channel — varies by backend
  write(data: string): Promise<void>
  readOutput(): Promise<string>  // reads from stdout/pipe/vsock
  kill(): Promise<void>
}
```

```typescript
// src/SubagentOrchestrator.ts
export interface OrchestratorConfig {
  daemon_secret: string    // HMAC signing key, from DaemonConfig
  sandbox_manager: SandboxManager
  mcp_hub: MCPHub
  graph: KnowledgeGraph
  event_bus: IEventBus
}

export interface SpawnRequest {
  session_id: string
  task: string
  task_type: TaskType
  context?: Record<string, unknown>
  graph_snapshot?: SubGraph    // optional pre-serialized subgraph for injection
  skill?: SkillDefinition      // when set, spawn in "skill mode" (inject role_prompt + subagent profile)
}

// Skill mode: when SpawnRequest.skill is set, SubagentOrchestrator.spawn() overrides:
//   - System prompt → skill.role_prompt
//   - CapabilityToken.allowed_tools → skill.allowed_tools
//   - CapabilityToken resource limits → skill.subagent profile values
//   - SandboxConfig → derived from skill.subagent profile (e.g., network_allowlist for /qa)

```

```typescript
// src/SkillInvoker.ts — thin wrapper for skill → subagent conversion

export interface SkillInvocation {
  skill: SkillDefinition
  args: Record<string, string>       // resolved from CLI args or workflow context
  session_id: string
}

export interface SkillOutput {
  format: 'prose' | 'json' | 'markdown' | 'diff'
  raw: string
  parsed: unknown                    // JSON-parsed if format=json, otherwise raw string
}

export class SkillInvoker {
  constructor(
    private readonly orchestrator: SubagentOrchestrator,
    private readonly inputResolver: SkillInputResolver
  ) {}

  async invoke(invocation: SkillInvocation): Promise<SkillOutput> {
    // 1. Resolve runtime variables in skill inputs
    const resolvedArgs = await this.inputResolver.resolve(invocation.skill, invocation.args)

    // 2. Build SpawnRequest with skill mode
    const req: SpawnRequest = {
      session_id: invocation.session_id,
      task: this.buildTaskPrompt(invocation.skill, resolvedArgs),
      task_type: this.inferTaskType(invocation.skill),
      skill: invocation.skill,
    }

    // 3. Spawn subagent
    const result = await this.orchestrator.spawn(req)

    // 4. Parse output based on skill's output.format
    return this.parseOutput(result.output, invocation.skill.output?.format ?? 'prose')
  }

  private parseOutput(raw: string, format: SkillOutput['format']): SkillOutput {
    if (format === 'json') {
      try { return { format, raw, parsed: JSON.parse(raw) } }
      catch { return { format: 'prose', raw, parsed: raw } }
    }
    return { format, raw, parsed: raw }
  }
}
```

```typescript
// src/SkillInputResolver.ts — resolves runtime variables in skill inputs

export class SkillInputResolver {
  constructor(
    private readonly sandboxManager: SandboxManager,
    private readonly artifactStore: ObjectStore
  ) {}

  async resolve(
    skill: SkillDefinition,
    userArgs: Record<string, string>
  ): Promise<Record<string, string>> {
    const resolved: Record<string, string> = {}
    for (const [key, value] of Object.entries(skill.inputs ?? {})) {
      let resolvedValue = typeof value === 'string' ? value : value.default ?? ''

      // $PROJECT_DIR → sandbox filesystem scope path
      resolvedValue = resolvedValue.replace('$PROJECT_DIR',
        this.sandboxManager.getFilesystemScope() ?? '/workspace')

      // $ARG_<name> → user-provided argument
      for (const [argKey, argVal] of Object.entries(userArgs)) {
        resolvedValue = resolvedValue.replace(`$ARG_${argKey.toUpperCase()}`, argVal)
      }

      // $LATEST_ARTIFACT:<type> → reads latest artifact of given type from .0agent/artifacts/
      const artifactMatch = resolvedValue.match(/\$LATEST_ARTIFACT:(\w+)/)
      if (artifactMatch) {
        const artifactType = artifactMatch[1]
        const latest = await this.artifactStore.getLatestArtifact(artifactType)
        resolvedValue = resolvedValue.replace(artifactMatch[0], latest?.content ?? '')
      }

      resolved[key] = resolvedValue
    }
    return resolved
  }
}
```

```typescript
// Skill chaining — in SubagentOrchestrator or daemon-level SkillChainController

export interface SkillChainConfig {
  auto_chain: boolean                // default: false
}

// When a skill completes and its definition has `workflow.feeds_into` set,
// and the daemon's SkillChainConfig.auto_chain is true:
//   1. Look up the next skill from workflow.feeds_into
//   2. Build a new SkillInvocation with the completed skill's output as context
//   3. Call SkillInvoker.invoke() for the next skill
// Example: /build completes → automatically triggers /review
// The chain stops if: auto_chain is false, feeds_into is empty, or max_chain_depth reached (default: 3)
```

---

## Resource Defaults (implement exactly)

```typescript
// src/ResourceDefaults.ts
export const RESOURCE_DEFAULTS: Record<TaskType, ResourceConfig> = {
  web_research: {
    max_duration_ms: 5 * 60 * 1000,      // 5 min
    max_llm_calls: 20,
    max_llm_tokens: 50_000,
    max_tool_calls: 50,
    allowed_tools: ['web_search', 'read_url', 'browser_navigate', 'browser_extract'],
    network_access: 'full',
    filesystem_access: 'none',
    memory_mb: 512,
    cpus: 1,
  },
  code_execution: {
    max_duration_ms: 2 * 60 * 1000,      // 2 min
    max_llm_calls: 10,
    max_llm_tokens: 20_000,
    max_tool_calls: 20,
    allowed_tools: ['execute_command'],
    network_access: 'none',
    filesystem_access: 'scoped',
    memory_mb: 512,
    cpus: 1,
  },
  browser_task: {
    max_duration_ms: 10 * 60 * 1000,     // 10 min
    max_llm_calls: 30,
    max_llm_tokens: 80_000,
    max_tool_calls: 100,
    allowed_tools: [
      'browser_navigate', 'browser_snapshot', 'browser_click',
      'browser_fill', 'browser_screenshot', 'browser_extract'
    ],
    network_access: 'full',
    filesystem_access: 'none',
    has_browser: true,
    has_display: true,
    memory_mb: 1024,
    cpus: 2,
  },
  file_editing: {
    max_duration_ms: 3 * 60 * 1000,      // 3 min
    max_llm_calls: 15,
    max_llm_tokens: 30_000,
    max_tool_calls: 40,
    allowed_tools: ['read_file', 'write_file', 'search_files'],
    network_access: 'none',
    filesystem_access: 'scoped',
    memory_mb: 256,
    cpus: 1,
  },
  send_message: {
    max_duration_ms: 1 * 60 * 1000,      // 1 min
    max_llm_calls: 5,
    max_llm_tokens: 5_000,
    max_tool_calls: 5,
    allowed_tools: ['send_email', 'slack_send_message'],
    network_access: 'allowlist',          // only messaging endpoints
    filesystem_access: 'none',
    memory_mb: 128,
    cpus: 1,
  },
}
```

---

## Critical Algorithms

### HMAC Token Signing and Validation

```typescript
// CapabilityToken.ts
import { createHmac, timingSafeEqual } from 'crypto'

const SIGNING_FIELDS_ORDER = [
  'id', 'subagent_id', 'parent_session_id', 'issued_at', 'expires_at',
  'trust_level', 'allowed_tools', 'blocked_tools', 'graph_read',
  'graph_write', 'allowed_credentials', 'max_duration_ms', 'max_llm_calls',
  'max_llm_tokens', 'max_tool_calls', 'sandbox'
]

function signToken(token: Omit<CapabilityToken, 'signature'>, secret: string): string {
  // Serialize only the defined fields in deterministic order
  const payload: Record<string, unknown> = {}
  for (const field of SIGNING_FIELDS_ORDER) {
    payload[field] = (token as Record<string, unknown>)[field]
  }
  const canonical = JSON.stringify(payload, Object.keys(payload).sort())
  return createHmac('sha256', secret).update(canonical).digest('hex')
}

function validateToken(token: CapabilityToken, secret: string): ValidationResult {
  // 1. Check expiry
  if (Date.now() > token.expires_at) {
    return { valid: false, reason: 'expired' }
  }

  // 2. Verify HMAC
  const expectedSig = signToken(token, secret)
  const expectedBuf = Buffer.from(expectedSig, 'hex')
  const actualBuf   = Buffer.from(token.signature, 'hex')

  if (expectedBuf.length !== actualBuf.length ||
      !timingSafeEqual(expectedBuf, actualBuf)) {
    return { valid: false, reason: 'invalid_signature' }
  }

  // 3. graph_write must ALWAYS be false
  if (token.graph_write !== false) {
    return { valid: false, reason: 'graph_write_not_allowed' }
  }

  return { valid: true }
}

function issueToken(req: TokenIssueRequest, secret: string): CapabilityToken {
  const defaults = RESOURCE_DEFAULTS[req.task_type]
  const now = Date.now()

  const tokenBase: Omit<CapabilityToken, 'signature'> = {
    id:                  crypto.randomUUID(),
    subagent_id:         req.subagent_id,
    parent_session_id:   req.parent_session_id,
    issued_at:           now,
    expires_at:          now + (req.override_duration_ms ?? defaults.max_duration_ms) + 60_000, // +1min grace
    trust_level:         1,   // always 1 for spawned subagents
    allowed_tools:       [...defaults.allowed_tools, ...(req.extra_tools ?? [])],
    blocked_tools:       ['spawn_subagent', 'graph_write', 'write_weight_event'],
    graph_read:          req.graph_read_scope ? mergeGraphReadScope(req.graph_read_scope) : DEFAULT_READ_SCOPE,
    graph_write:         false,
    allowed_credentials: [],
    max_duration_ms:     req.override_duration_ms ?? defaults.max_duration_ms,
    max_llm_calls:       defaults.max_llm_calls,
    max_llm_tokens:      defaults.max_llm_tokens,
    max_tool_calls:      defaults.max_tool_calls,
    sandbox: {
      type:               'docker',   // overridden by SandboxManager based on detected backend
      network_access:     defaults.network_access,
      filesystem_access:  defaults.filesystem_access,
      has_browser:        defaults.has_browser ?? false,
      has_display:        defaults.has_display ?? false,
    },
  }

  const signature = signToken(tokenBase, secret)
  return { ...tokenBase, signature }
}
```

### Subagent Lifecycle (implement exactly)

```typescript
// SubagentOrchestrator.ts

async spawn(req: SpawnRequest): Promise<SubagentResult> {
  const subagent_id = crypto.randomUUID()

  // 1. Issue capability token
  // SKILL MODE: if req.skill is set, override token config from skill's subagent profile
  const tokenRequest: TokenIssueRequest = {
    subagent_id,
    parent_session_id: req.session_id,
    task_type: req.task_type,
  }

  if (req.skill) {
    // Apply skill's allowed_tools to the token (overrides task_type defaults)
    tokenRequest.extra_tools = req.skill.allowed_tools ?? []
    // Apply skill's subagent profile resource limits
    if (req.skill.subagent?.max_duration_ms) {
      tokenRequest.override_duration_ms = req.skill.subagent.max_duration_ms
    }
    // Skill-specific sandbox config (e.g., /qa needs browser + network allowlist)
    tokenRequest.sandbox_overrides = req.skill.subagent?.sandbox
  }

  const token = issueToken(tokenRequest, this.config.daemon_secret)

  this.eventBus.emit({ type: 'subagent.spawned', subagent_id, tools: token.allowed_tools })

  // 2. Create sandbox
  const sandboxConfig = buildSandboxCreateConfig(token, req)
  const handle = await this.sandboxManager.create(sandboxConfig)

  // 3. Register watchdog
  const watchdog = new Watchdog(subagent_id, token.max_duration_ms, async () => {
    await handle.kill()
  })
  watchdog.start()

  let result: SubagentResult
  try {
    // 4. Inject runtime payload via stdin/env
    const payload = JSON.stringify({
      token: token,
      task: req.task,
      context: req.context ?? {},
      graph_snapshot: req.graph_snapshot ? serializeSubGraph(req.graph_snapshot) : null,
      mcp_proxy_url: `http://127.0.0.1:${this.proxyPort}/mcp/${subagent_id}`,
    })
    await handle.write(payload + '\n__PAYLOAD_END__\n')

    // 5. Wait for output (blocking — watchdog handles timeout)
    const rawOutput = await handle.readOutput()
    result = parseSubagentOutput(rawOutput, subagent_id, req.session_id, req.task)

  } catch (err) {
    result = errorResult(subagent_id, req, err)
  } finally {
    // 6. ALWAYS destroy sandbox, even on error
    watchdog.cancel()
    await this.sandboxManager.destroy(handle).catch(e => {
      console.error(`Failed to destroy sandbox ${handle.id}:`, e)
    })
  }

  // 7. Process artifacts — persist screenshots to ObjectStore
  for (const artifact of result.artifacts) {
    if (artifact.type === 'screenshot') {
      await this.objectStore.saveArtifact(artifact)
    }
  }

  this.eventBus.emit({
    type: 'subagent.completed',
    subagent_id,
    duration_ms: result.duration_ms
  })

  return result
}
```

### Docker Backend

```typescript
// DockerBackend.ts
import { spawn } from 'child_process'

async create(config: SandboxCreateConfig): Promise<SandboxHandle> {
  const args = [
    'run', '--rm', '--interactive',
    `--memory=${config.memory_mb}m`,
    `--cpus=${config.cpus}`,
    '--read-only',
    '--tmpfs', '/tmp:size=100m',
    '--security-opt', 'no-new-privileges',
  ]

  // Network config
  if (config.network === 'none') {
    args.push('--network=none')
  } else if (config.network === 'allowlist') {
    // Create custom network with iptables rules in entrypoint
    args.push('--network=bridge')
    // inject allowlist as env var for runtime enforcement
    args.push('--env', `NETWORK_ALLOWLIST=${config.network_allowlist?.join(',') ?? ''}`)
  }

  // Environment variables
  for (const [k, v] of Object.entries(config.env)) {
    args.push('--env', `${k}=${v}`)
  }

  // Image selection
  const image = config.has_browser
    ? '0agent/subagent-runtime:chrome'
    : '0agent/subagent-runtime:latest'
  args.push(image)

  const proc = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] })

  const id = crypto.randomUUID()
  return {
    id,
    backend_type: 'docker',
    created_at: Date.now(),
    write: async (data: string) => {
      proc.stdin.write(data)
    },
    readOutput: () => new Promise((resolve, reject) => {
      let output = ''
      proc.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
      proc.stderr.on('data', (chunk: Buffer) => { console.error('[subagent stderr]', chunk.toString()) })
      proc.on('close', (code) => {
        if (code === 0 || output.includes('"exit_reason"')) resolve(output)
        else reject(new Error(`Docker exited with code ${code}`))
      })
      proc.on('error', reject)
    }),
    kill: async () => {
      proc.kill('SIGKILL')
    }
  }
}

async destroy(handle: SandboxHandle): Promise<void> {
  // --rm flag handles cleanup, but forcibly kill process if still running
  handle.kill().catch(() => {})
}
```

### Watchdog

```typescript
// Watchdog.ts
export class Watchdog {
  private timer?: NodeJS.Timeout

  constructor(
    private readonly subagent_id: string,
    private readonly timeout_ms: number,
    private readonly kill_fn: () => Promise<void>
  ) {}

  start(): void {
    this.timer = setTimeout(async () => {
      console.warn(`[Watchdog] Subagent ${this.subagent_id} exceeded ${this.timeout_ms}ms — killing`)
      await this.kill_fn()
    }, this.timeout_ms)
    this.timer.unref()   // don't keep event loop alive
  }

  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }
}
```

### Filtered MCP Proxy (updated for HMAC tokens)

```typescript
// FilteredProxy.ts (Phase 3 update)

export class FilteredProxy {
  constructor(
    private readonly upstream: MCPHub,
    private readonly daemon_secret: string
  ) {}

  // Called per subagent with their token
  createProxyFor(token: CapabilityToken): SubagentProxy {
    // Validate token signature on creation
    const validation = validateToken(token, this.daemon_secret)
    if (!validation.valid) throw new Error(`Invalid capability token: ${validation.reason}`)

    return new SubagentProxy(token, this.upstream)
  }
}

class SubagentProxy {
  constructor(
    private readonly token: CapabilityToken,
    private readonly upstream: MCPHub
  ) {}

  async call(tool_name: string, input: Record<string, unknown>): Promise<MCPCallResult> {
    // 1. Check expiry on every call
    if (Date.now() > this.token.expires_at) {
      throw new Error('Capability token expired')
    }

    // 2. Check blocked tools first
    if (this.token.blocked_tools.includes(tool_name)) {
      throw new Error(`Tool '${tool_name}' is explicitly blocked`)
    }

    // 3. Check allowed tools
    if (!this.token.allowed_tools.includes(tool_name)) {
      throw new Error(`Tool '${tool_name}' not in allowed_tools list`)
    }

    // 4. Special blocks: graph writes, subagent spawning
    if (tool_name === 'spawn_subagent') {
      throw new Error('Subagents cannot spawn further subagents (Level 2 restriction)')
    }

    // 5. Forward to upstream
    return this.upstream.callTool(tool_name, input)
  }
}
```

### Subagent Runtime Agent Loop

```typescript
// packages/subagent-runtime/src/AgentLoop.ts

export class AgentLoop {
  constructor(
    private readonly token: CapabilityToken,
    private readonly proxy: MCPProxy,
    private readonly llm: ILLMClient,
    private readonly tracker: ResourceTracker,
    private readonly output: OutputChannel
  ) {}

  async run(task: string): Promise<void> {
    const messages: LLMMessage[] = [
      { role: 'system', content: buildSystemPrompt(this.token) },
      { role: 'user',   content: task }
    ]

    while (true) {
      // Check resource limits before each LLM call
      if (!this.tracker.canMakeLLMCall()) {
        this.output.write({ exit_reason: 'resource_limit', output: 'LLM call limit reached' })
        return
      }

      const response = await this.llm.complete(messages)
      this.tracker.recordLLMCall(response.tokens_used)

      if (response.finish_reason === 'stop' || !response.tool_calls?.length) {
        // Final answer
        this.output.write({
          exit_reason: 'completed',
          output: response.content,
          tool_calls: this.tracker.getToolCallRecords(),
          llm_calls_used: this.tracker.llm_calls,
          tokens_used: this.tracker.tokens_used,
        })
        return
      }

      // Execute tool calls
      for (const tc of response.tool_calls) {
        if (!this.tracker.canMakeToolCall()) {
          this.output.write({ exit_reason: 'resource_limit', output: 'Tool call limit reached' })
          return
        }
        const result = await this.proxy.call(tc.name, tc.input)
        this.tracker.recordToolCall(tc.name, tc.input, result)
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) })
      }

      messages.push({ role: 'assistant', ...response })
    }
  }
}

function buildSystemPrompt(token: CapabilityToken, skill?: SkillDefinition): string {
  // SKILL MODE: if skill has a role_prompt, use it as the system prompt
  if (skill?.role_prompt) {
    return `${skill.role_prompt}

Available tools: ${token.allowed_tools.join(', ')}
You CANNOT write to the knowledge graph.
You CANNOT spawn other agents.
Complete the assigned task efficiently within your resource limits.`
  }

  return `You are a subagent with the following capabilities:
Available tools: ${token.allowed_tools.join(', ')}
You CANNOT write to the knowledge graph.
You CANNOT spawn other agents.
Complete the assigned task efficiently within your resource limits.`
}
```

---

## Sandbox Dockerfiles

### sandbox-images/ubuntu-minimal/Dockerfile
```dockerfile
FROM ubuntu:22.04
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl && \
    rm -rf /var/lib/apt/lists/*

# Install Bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:$PATH"

# Copy runtime bundle (injected during build)
WORKDIR /agent
COPY dist/subagent-runtime.js ./runtime.js

# Read payload from stdin, execute runtime
ENTRYPOINT ["bun", "run", "runtime.js"]
```

### sandbox-images/ubuntu-chrome/Dockerfile
```dockerfile
FROM 0agent/subagent-runtime:latest

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium-browser \
    xvfb \
    x11vnc \
    novnc \
    websockify \
    fonts-liberation \
    libgbm1 \
    && rm -rf /var/lib/apt/lists/*

# Start Xvfb on display :99, then run agent
COPY entrypoint-chrome.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
```

```bash
#!/bin/bash
# entrypoint-chrome.sh
Xvfb :99 -screen 0 1280x720x24 &
export DISPLAY=:99

# Start noVNC for dashboard observation
websockify --web /usr/share/novnc 6080 localhost:5900 &
x11vnc -display :99 -nopw -listen localhost -quiet &

exec bun run /agent/runtime.js
```

---

## Browser MCP Tools

```typescript
// packages/mcp-hub/src/builtin/BrowserMCP.ts
// Uses playwright or agent-browser (puppeteer-compatible)

export const BROWSER_TOOLS = {
  browser_navigate: async (args: { url: string }) => {
    await page.goto(args.url, { waitUntil: 'networkidle' })
    return { success: true, url: page.url() }
  },

  browser_snapshot: async () => {
    // Returns accessibility tree as JSON (not screenshot — lower token cost)
    const snapshot = await page.accessibility.snapshot()
    return snapshot
  },

  browser_click: async (args: { ref: string }) => {
    // ref is an accessibility node ref from snapshot
    await page.click(`[data-agent-ref="${args.ref}"]`)
    return { clicked: true }
  },

  browser_fill: async (args: { ref: string; text: string }) => {
    await page.fill(`[data-agent-ref="${args.ref}"]`, args.text)
    return { filled: true, text: args.text }
  },

  browser_screenshot: async () => {
    const buf = await page.screenshot({ type: 'png', fullPage: false })
    return {
      path: null,
      data: buf.toString('base64'),
      type: 'image/png'
    }
  },

  browser_extract: async (args: { instruction: string }) => {
    // Use LLM to extract structured data from current page content
    const html = await page.content()
    // Return structured JSON per instruction
    return { extracted: '...' }  // LLM call inside BrowserMCP
  },
}
```

---

## Sandbox Auto-Detection Order

```typescript
// SandboxManager.ts

async detectBackend(): Promise<SandboxConfig['type']> {
  // 1. Firecracker: /dev/kvm must be accessible r/w
  try {
    await fs.access('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK)
    return 'firecracker'
  } catch {}

  // 2. Docker
  try {
    const { stdout } = await execAsync('docker info --format "{{.ServerVersion}}"', { timeout: 3000 })
    if (stdout.trim()) return 'docker'
  } catch {}

  // 3. Podman
  try {
    const { stdout } = await execAsync('podman info --format "{{.Version.Version}}"', { timeout: 3000 })
    if (stdout.trim()) return 'podman'
  } catch {}

  // 4. Bubblewrap
  try {
    const { stdout } = await execAsync('bwrap --version', { timeout: 2000 })
    if (stdout.includes('bubblewrap')) return 'bwrap'
  } catch {}

  // 5. Cloud (E2B) — check config
  if (this.config?.e2b_api_key) return 'cloud'

  // 6. Process (always available)
  return 'process'
}
```

---

## Implementation Order

### Week 8 (Days 1–5): CapabilityToken + FilteredProxy

1. **Day 1**: `CapabilityToken.ts` — full implementation, HMAC sign/validate. Write `capability_token.test.ts` immediately.
2. **Day 2**: `ResourceDefaults.ts` — all 5 task types with exact defaults.
3. **Day 3**: `FilteredProxy.ts` — Phase 3 update with full HMAC validation. Write `filtered_proxy.test.ts`.
4. **Day 4**: `SandboxManager.ts` — interface + auto-detection logic.
5. **Day 5**: `ProcessBackend.ts` — simplest backend for local testing.

### Week 9 (Days 6–10): Docker + Runtime

6. **Day 6**: `DockerBackend.ts` — full implementation with resource limits.
7. **Day 7**: `packages/subagent-runtime` setup — `main.ts`, `TokenValidator.ts`, `OutputChannel.ts`.
8. **Day 8**: `AgentLoop.ts` + `ResourceTracker.ts` — agent loop without real LLM (inject mock).
9. **Day 9**: `MCPProxy.ts` in runtime — connect to parent's FilteredProxy over HTTP.
10. **Day 10**: Build Docker images, write `sandbox_lifecycle.test.ts`.

### Week 10 (Days 11–15): Orchestrator + Browser

11. **Day 11**: `Watchdog.ts` — timeout enforcement.
12. **Day 12**: `SubagentOrchestrator.ts` — full spawn lifecycle.
13. **Day 13**: `BrowserMCP.ts` — browser tool implementations (use Playwright).
14. **Day 14**: `sandbox-images/ubuntu-chrome/Dockerfile` + entrypoint.
15. **Day 15**: Write `browser_sandbox.test.ts` (integration, requires Docker).

### Week 11 (Days 16–20): Other Backends + Polish

16. **Day 16**: `PodmanBackend.ts` (thin wrapper over DockerBackend with podman binary).
17. **Day 17**: `BwrapBackend.ts` — bubblewrap namespaces.
18. **Day 18**: `FirecrackerBackend.ts` — vsock comm, snapshot restore stub.
19. **Day 19**: `CloudBackend.ts` — E2B API integration.
20. **Day 20**: Integration test pass, fix any sandbox destroy leaks.

---

## External Dependencies

### packages/subagent
```json
{
  "dependencies": {
    "@0agent/core": "workspace:*",
    "@0agent/mcp-hub": "workspace:*",
    "uuid": "^9.0.0",
    "zod": "^3.22.4"
  }
}
```

### packages/subagent-runtime
```json
{
  "dependencies": {
    "zod": "^3.22.4"
  },
  "devDependencies": {
    "bun-build": "latest"
  },
  "scripts": {
    "build": "bun build src/main.ts --outfile dist/subagent-runtime.js --target bun --minify"
  }
}
```

### packages/mcp-hub (additions for BrowserMCP)
```json
{
  "dependencies": {
    "playwright": "^1.42.0"
  }
}
```

---

## Acceptance Criteria (Testable)

1. **Token issue + valid**: `issueToken(req, secret).signature` is non-empty, `validateToken(token, secret).valid === true`.
2. **Token expiry**: Set `expires_at` to 1ms in the past → `validateToken()` returns `{ valid: false, reason: 'expired' }`.
3. **Token tamper**: Modify `allowed_tools` after signing → `validateToken()` returns `{ valid: false, reason: 'invalid_signature' }`.
4. **graph_write invariant**: Token with `graph_write: true` (manually crafted) → `validateToken()` rejects with `'graph_write_not_allowed'`.
5. **FilteredProxy blocks**: Attempt to call `spawn_subagent` via proxy → throws. Call allowed tool → succeeds.
6. **Docker sandbox lifecycle**: `DockerBackend.create()` → write task → `readOutput()` returns JSON with `exit_reason: 'completed'` → `destroy()` leaves no containers (`docker ps -a` grep clean).
7. **Watchdog kills**: Set `max_duration_ms: 500`, run slow task → after 500ms sandbox is killed, result has `exit_reason: 'timeout'`.
8. **Sandbox always destroyed on error**: Inject a task that throws → sandbox is still destroyed (verify no container leak).
9. **Browser navigate + screenshot**: `browser_task` subagent navigates to `https://example.com`, calls `browser_screenshot`, result contains `artifacts` with type=`screenshot` and base64 PNG data.
10. **Graph write blocked**: Subagent runtime `MCPProxy.call('write_node', {...})` throws (not in allowed_tools, also in blocked_tools).
11. **No sub-subagents**: `MCPProxy.call('spawn_subagent', {...})` throws `'Subagents cannot spawn further subagents'`.
12. **Resource tracker**: After `max_llm_calls` LLM calls, `ResourceTracker.canMakeLLMCall()` returns false, agent exits with `exit_reason: 'resource_limit'`.
13. **Sandbox auto-detection**: On machine with Docker, `detectBackend()` returns `'docker'`. Mock `/dev/kvm` accessible → returns `'firecracker'`.
14. **Artifact persistence**: Browser screenshot artifact is saved to ObjectStore, retrievable by artifact ID.
15. **Skill spawns subagent with role_prompt**: `0agent /review` spawns a subagent whose system prompt contains the review skill's `role_prompt` text, and whose tool list matches the skill's `allowed_tools`.
16. **Skill allowed_tools enforced by FilteredProxy**: A skill-spawned subagent with `allowed_tools: ['read_file', 'search_files']` attempting to call `execute_command` → FilteredProxy rejects with `'Tool not in allowed_tools list'`.
17. **$PROJECT_DIR resolves correctly**: `SkillInputResolver` resolves `$PROJECT_DIR` to the correct scoped filesystem path inside the sandbox (matching `SandboxConfig.filesystem_scope`).
18. **Skill with browser sandbox**: `/qa` skill spawns a browser sandbox with `network_access: 'allowlist'` and the user-provided URL in the allowlist.
19. **Skill chaining**: With `workflow.auto_chain: true`, `/build` completing triggers `/review` automatically. With `auto_chain: false` (default), no automatic chain occurs.

---

## Risks and Gotchas

1. **Docker --read-only with Bun** — Bun writes to its cache directory at startup. With `--read-only`, this will fail. Mount `/root/.bun` as a tmpfs too: `--tmpfs /root/.bun:size=50m`. Test this with the exact Docker image before declaring victory.

2. **HMAC key management** — `daemon_secret` is a 32-byte random key generated on first `0agent init`, stored in `~/.0agent/config.yaml` under `server.secret`. It must NOT be in the git repo, NOT be logged, and must be rotated carefully (all in-flight tokens become invalid). Add a `0agent config rotate-secret --confirm` command stub.

3. **Sandbox destroy race condition** — The `finally` block calls `sandboxManager.destroy()` but the watchdog may simultaneously be calling `handle.kill()`. Make `kill()` idempotent (calling on an already-killed process is a no-op, not an error). Check process status before sending SIGKILL.

4. **Playwright inside Docker** — Playwright downloads browser binaries at install time. The Docker image must run `playwright install chromium` during image build, not at runtime. Pin Playwright version in Dockerfile to match the npm package version.

5. **subagent-runtime must bundle to a single file** — Inside the sandbox, there is no `node_modules`. Bundle `subagent-runtime` with `bun build --target bun --bundle`. The bundle must include all dependencies. Do not use dynamic requires.

6. **Output channel framing** — The runtime writes JSON output to stdout. The parent reads it. If the output is large (e.g., a base64 screenshot), the entire JSON must arrive before the parent declares the subagent done. Use a sentinel line `__OUTPUT_END__` after the JSON so the parent knows when to stop reading.

7. **noVNC port mapping** — If `has_display: true`, the Docker backend must expose port 6080 from the container for the dashboard's noVNC embed. Assign a random host port (`--publish 0:6080`), record the actual bound port, return it in the `SandboxHandle` as `vnc_port`. The daemon passes this to the event bus so the dashboard can embed it.

8. **Firecracker vsock** — Firecracker uses vsock (AF_VSOCK) for host-guest communication. This is Linux-only and requires the `vhost-vsock` kernel module. On macOS, skip Firecracker entirely. The backend's `isAvailable()` must check for Linux AND `/dev/kvm`. CI tests should skip Firecracker tests if not available.

9. **Trust level 1 vs 2** — Level 1 = spawned subagent (cannot spawn further agents). Level 2 = reserved for future multi-hop agent chains. In Phase 3, always issue Level 1 tokens. The `blocked_tools` list for Level 1 must include `spawn_subagent`. Never remove this block without explicit architecture review.

10. **E2B timeout** — E2B Cloud sandbox has its own timeout that may conflict with `max_duration_ms`. Set E2B timeout to `max_duration_ms + 10_000` (10s buffer for cleanup). If E2B times out first, the result will be empty — handle this in `parseSubagentOutput` by returning `exit_reason: 'timeout'`.

11. **MCP proxy URL inside sandbox** — The sandbox runs in its own network namespace. To reach the daemon's MCP proxy, use the Docker host gateway IP (`172.17.0.1` for default Docker bridge, or `host-gateway` DNS alias). For `--network=none` sandboxes, the MCP proxy must be served via a Unix socket mounted into the container as a volume, or the output channel must carry tool call requests back to the parent for execution (a "tool gateway" pattern). Implement the tool gateway pattern for network-isolated sandboxes.

---

## Integration Points with Other Phases

- **Phase 2 (Daemon)**: `SubagentOrchestrator` is injected into `SessionManager`. Phase 2's `SessionManager.runTask()` stub is replaced with real orchestration. No API surface changes — the session REST routes remain identical.
- **Phase 2 (MCP Hub)**: `FilteredProxy` was a stub in Phase 2 (plain `allowed_tools[]`). Phase 3 upgrades it to full HMAC validation. This is a drop-in replacement with the same interface.
- **Phase 4 (Learning Pipeline)**: `SubagentResult.artifacts` (screenshots) are fed into the embedding pipeline. `SubagentResult.tool_calls` feed into credit attribution. The `TraversalLedger` in Phase 4 will log which subagent tool calls were "attribution-grade".
- **Phase 4 (Dashboard)**: `vnc_port` from `SandboxHandle` is used by the `/subagents` dashboard page's `SubagentVNC.svelte` component. The daemon's WebSocket must include `vnc_port` in the `subagent.spawned` event.
- **Phase 5 (Native)**: The Rust `core-native` package's BFS/DFS traversal is called when building `graph_snapshot` for injection into subagents. Large subgraph serialization benefits most from native speed.
- **Phase 2 (Skill Library)**: `SkillInvoker` consumes `SkillDefinition` objects loaded by the Phase 2 `SkillRegistry`. `SkillInputResolver` was originally planned for Phase 2 but moved here because it needs sandbox context (`$PROJECT_DIR` resolution depends on `SandboxManager`). The Phase 2 `CommandRouter` calls `SkillInvoker.invoke()` when a `/skill` command is received.
- **Phase 4 (Learning Pipeline)**: Skill invocations create traces with `metadata.skill_name` set, enabling `0agent trace list --skill review`. Skill chaining feeds into the sprint workflow graph edges.
