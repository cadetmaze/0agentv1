# Phase 1: Core Engine (Weeks 1–4)

## Goal

Get the knowledge graph, weight propagation engine, decay scheduler, entity resolution, and bootstrap mode running and fully tested. By end of phase, `pnpm test --filter=@0agent/core` must pass all unit tests and the 50-trace convergence test must pass. No daemon, no CLI, no subagents — this is purely the foundational data layer and learning engine.

---

## Complete File List

### Workspace Root
| File | Responsibility |
|------|---------------|
| `pnpm-workspace.yaml` | Declares all packages/* as workspace members |
| `turbo.json` | Pipeline: build → test → lint, with caching config |
| `package.json` | Root devDependencies: turbo, vitest, typescript, biome |
| `.nvmrc` / `.tool-versions` | Pin Bun version (≥1.1) |
| `tsconfig.base.json` | Shared TS config: strict, moduleResolution bundler, target ES2022 |

### packages/core
| File | Responsibility |
|------|---------------|
| `package.json` | `@0agent/core`, deps: better-sqlite3, usearch, @xenova/transformers, uuid, zod |
| `tsconfig.json` | Extends tsconfig.base, paths alias `@core/*` |
| `index.ts` | Barrel: re-exports all public types and classes |
| `src/graph/GraphNode.ts` | Node data class — multimodal content array, embedding field |
| `src/graph/GraphEdge.ts` | Edge data class — weight, lock, decay_rate, weight_event_log ref |
| `src/graph/SubGraph.ts` | Container for entity subgraph nodes/edges |
| `src/graph/GraphQuery.ts` | Query builder — structural (SQL) + semantic (HNSW merge) |
| `src/graph/KnowledgeGraph.ts` | Main graph: CRUD, subgraph lifecycle, delegates to SQLiteAdapter |
| `src/storage/adapters/SQLiteAdapter.ts` | All DDL + prepared statements, transaction helpers |
| `src/storage/TraceStore.ts` | Immutable trace INSERT + read by id/session |
| `src/storage/WeightEventLog.ts` | Append-only weight_events INSERT + query by edge/trace |
| `src/storage/ObjectStore.ts` | File/screenshot/archive storage (filesystem + metadata in SQLite) |
| `src/embedding/adapters/NomicAdapter.ts` | Nomic Embed v2.5 via local Ollama REST |
| `src/embedding/adapters/OpenAIAdapter.ts` | text-embedding-3-small via OpenAI REST |
| `src/embedding/adapters/OllamaAdapter.ts` | Generic Ollama `/api/embeddings` endpoint |
| `src/embedding/MultimodalEmbedder.ts` | Fused embedding: text+image+code+audio → single vector |
| `src/embedding/HNSWIndex.ts` | usearch HNSW wrapper: add, search, save/load mmap file |
| `src/engine/WeightPropagation.ts` | Margin-based influence, OCC update, step discount |
| `src/engine/DecayScheduler.ts` | 6h interval, 48h grace, 24h max deferral, decays toward 0.5 |
| `src/engine/SelectionPolicy.ts` | Epsilon-greedy + temperature-based edge/strategy selection |
| `src/concurrency/EdgeWeightUpdater.ts` | OCC compare-and-swap with 3-retry exponential backoff |
| `src/entity/AliasIndex.ts` | Alias CRUD, abbreviation generation, fuzzy scan |
| `src/entity/NodeResolutionService.ts` | Dedup service: exact → alias → fuzzy, create if below threshold |
| `src/bootstrap/StagedMutations.ts` | Pending graph proposals, TTL 14 days, commit on outcome signal |
| `src/bootstrap/HypothesisManager.ts` | Track hypotheses, promote/demote, TTL pruning |
| `src/bootstrap/GraphConstructor.ts` | LLM → CONTEXT/STRATEGY/PLAN/EXPECTED_OUTCOME → graph proposals |
| `src/bootstrap/BootstrapProtocol.ts` | Detect bootstrap mode (< 10 nodes), orchestrate constructor |

### tests
| File | Responsibility |
|------|---------------|
| `tests/unit/graph/KnowledgeGraph.test.ts` | CRUD, subgraph, concurrent updates |
| `tests/unit/graph/WeightPropagation.test.ts` | Margin influence, step discount, credit formula |
| `tests/unit/graph/Decay.test.ts` | Decay toward 0.5, grace period, deferral cap |
| `tests/unit/entity/NodeResolutionService.test.ts` | Dedup, confidence thresholds |
| `tests/unit/entity/AliasIndex.test.ts` | Alias CRUD, abbreviation, fuzzy scan |
| `tests/unit/bootstrap/GraphConstructor.test.ts` | LLM stub → proposal generation |
| `tests/unit/bootstrap/StagedMutations.test.ts` | TTL enforcement, commit/discard |
| `tests/unit/bootstrap/HypothesisManager.test.ts` | Promote, demote, TTL prune |
| `tests/convergence/convergence.test.ts` | SimulatedEnvironment, 50-trace convergence |

---

## Key Interfaces and Types

```typescript
// src/graph/GraphNode.ts
export enum NodeType {
  ENTITY       = "entity",
  CONTEXT      = "context",
  STRATEGY     = "strategy",
  PLAN         = "plan",
  STEP         = "step",
  OUTCOME      = "outcome",
  SIGNAL       = "signal",
  TOOL         = "tool",
  CONSTRAINT   = "constraint",
  HYPOTHESIS   = "hypothesis",
}

export enum ContentType {
  TEXT       = "text",
  IMAGE      = "image",
  CODE       = "code",
  STRUCTURED = "structured",
  AUDIO      = "audio",
}

export interface NodeContent {
  id: string
  node_id: string
  type: ContentType
  data: string
  metadata: Record<string, unknown>
}

export interface GraphNode {
  id: string
  graph_id: string
  label: string
  type: NodeType
  created_at: number
  last_seen: number
  visit_count: number
  metadata: Record<string, unknown>
  subgraph_id?: string
  embedding?: Float32Array
  embedding_model?: string
  embedding_at?: number
  content: NodeContent[]
}
```

```typescript
// src/graph/GraphEdge.ts
export enum EdgeType {
  LEADS_TO      = "leads_to",
  REQUIRES      = "requires",
  CONTRADICTS   = "contradicts",
  SUPPORTS      = "supports",
  PRODUCES      = "produces",
  MEMBER_OF     = "member_of",
  ALIAS_OF      = "alias_of",
  MIRRORS       = "mirrors",
}

export interface GraphEdge {
  id: string
  graph_id: string
  from_node: string
  to_node: string
  type: EdgeType
  weight: number         // 0.0–1.0, neutral = 0.5
  locked: boolean
  decay_rate: number     // default 0.001
  created_at: number
  last_traversed?: number
  traversal_count: number
  metadata: Record<string, unknown>
}
```

```typescript
// src/engine/WeightPropagation.ts — key interfaces
export interface StepLedger {
  edge_id: string
  step_index: number
  has_sub_outcome: boolean
  weight_at_traversal: number
}

export interface PropagationResult {
  edge_id: string
  old_weight: number
  new_weight: number
  delta: number
  credit: number
  influence: number
  discount: number
}

export interface OutcomeSignal {
  value: number           // -1.0 to 1.0
  type: 'explicit' | 'implicit' | 'deferred'
  trace_id: string
  resolved_at: number
}
```

```typescript
// src/bootstrap/StagedMutations.ts
export interface StagedMutation {
  id: string
  trace_id: string
  proposed_nodes: GraphNode[]
  proposed_edges: GraphEdge[]
  created_at: number
  expires_at: number      // created_at + 14 days in ms
  committed: boolean
  discarded: boolean
}
```

```typescript
// src/entity/NodeResolutionService.ts
export interface ResolutionResult {
  node_id: string
  confidence: number
  match_type: 'exact' | 'alias' | 'fuzzy' | 'created'
}

export interface ResolutionConfig {
  exact_threshold: number      // 1.0
  alias_threshold: number      // 0.9
  fuzzy_threshold: number      // 0.65
  disambiguation_threshold: number  // 0.80
}
```

```typescript
// src/storage/adapters/SQLiteAdapter.ts
export interface SQLiteAdapterConfig {
  db_path: string
  wal_mode: boolean    // always true
  busy_timeout_ms: number
}

// All methods are synchronous (better-sqlite3 is sync)
export interface ISQLiteAdapter {
  // Nodes
  insertNode(node: GraphNode): void
  getNode(id: string): GraphNode | null
  updateNodeLastSeen(id: string, ts: number): void
  deleteNode(id: string): void
  queryNodes(graph_id: string, type?: NodeType, limit?: number): GraphNode[]

  // Edges
  insertEdge(edge: GraphEdge): void
  getEdge(id: string): GraphEdge | null
  updateEdgeWeight(id: string, weight: number, expected: number): boolean  // OCC
  deleteEdge(id: string): void
  getEdgesByNode(node_id: string, direction: 'from' | 'to' | 'both'): GraphEdge[]

  // Weight events
  insertWeightEvent(event: WeightEvent): void
  getWeightEvents(edge_id: string): WeightEvent[]
  getWeightEventsByTrace(trace_id: string): WeightEvent[]

  // Traces
  insertTrace(trace: TraceRecord): void
  getTrace(id: string): TraceRecord | null
  updateTraceOutcome(id: string, signal: number, type: string, resolved_at: number): void

  // Aliases
  insertAlias(alias: string, node_id: string, confidence: number): void
  getAliases(node_id: string): AliasRecord[]
  findByAlias(alias: string): AliasRecord[]
  deleteAlias(alias: string, node_id: string): void
}
```

---

## Implementation Order

Build in strict dependency order — nothing imports from a module not yet defined.

### Step 1: Workspace Scaffold (Day 1)
1. `pnpm-workspace.yaml` — list all packages
2. `turbo.json` — pipeline with `dependsOn: ["^build"]`
3. Root `package.json` — workspace root with turbo, vitest, typescript, biome
4. `tsconfig.base.json` — shared compiler options
5. `packages/core/package.json` + `tsconfig.json`
6. Run `pnpm install` and verify workspace links

### Step 2: SQLite Schema + Adapter (Days 2–3)
Build first because everything else depends on persistence.
1. `src/storage/adapters/SQLiteAdapter.ts`
   - Open DB, set `PRAGMA journal_mode=WAL`, `PRAGMA busy_timeout=5000`
   - Run all CREATE TABLE IF NOT EXISTS statements
   - Create all indexes: nodes(graph_id, type), edges(from_node), edges(to_node), aliases(alias), weight_events(edge_id), weight_events(trace_id)
   - Implement all methods as prepared statements (cache with `.prepare()`)
2. `src/storage/WeightEventLog.ts` — thin wrapper calling adapter
3. `src/storage/TraceStore.ts` — thin wrapper calling adapter
4. Write `tests/unit/graph/KnowledgeGraph.test.ts` minimal CRUD test

### Step 3: Graph Data Types (Days 3–4)
1. `src/graph/GraphNode.ts` — enums + interface, pure data
2. `src/graph/GraphEdge.ts` — enums + interface, pure data
3. `src/graph/SubGraph.ts` — container: `{ id, root_entity_id, nodes: Map<string,GraphNode>, edges: Map<string,GraphEdge> }`
4. `src/graph/GraphQuery.ts` — query builder (no execution yet)

### Step 4: KnowledgeGraph (Days 4–5)
1. `src/graph/KnowledgeGraph.ts`
   - Constructor takes `SQLiteAdapter` + optional `HNSWIndex`
   - Implement: `addNode`, `getNode`, `addEdge`, `getEdge`, `updateEdgeWeight`, `deleteNode`, `deleteEdge`
   - `getSubGraph(entity_id, depth)` — BFS from entity node
   - `queryStructural(GraphQuery)` → hits SQLite
   - `querySemantic(vector, limit)` → hits HNSW, then resolves to nodes
   - `queryMerged(GraphQuery)` → union of structural + semantic, ranked

### Step 5: Concurrency + OCC (Day 5)
1. `src/concurrency/EdgeWeightUpdater.ts`
   - `update(edge_id, expected_weight, new_weight, reason, trace_id)`: calls `adapter.updateEdgeWeight(id, new, expected)`
   - If returns false (OCC miss): backoff 1ms, 2ms, 4ms, retry up to 3 times
   - On 3rd failure: log "OCC conflict LWW fallback" and force-write
   - Always writes a `WeightEvent` on success

### Step 6: Weight Propagation (Days 6–7)
This is the most critical algorithm. Implement exactly per PRD.
1. `src/engine/WeightPropagation.ts`
2. `src/engine/SelectionPolicy.ts`
3. Write `tests/unit/graph/WeightPropagation.test.ts` — test every formula

### Step 7: Decay Scheduler (Day 7)
1. `src/engine/DecayScheduler.ts`
2. Write `tests/unit/graph/Decay.test.ts`

### Step 8: Embeddings (Days 8–9)
1. `src/embedding/adapters/OllamaAdapter.ts` — base fetch wrapper
2. `src/embedding/adapters/NomicAdapter.ts` — extends Ollama with model name
3. `src/embedding/adapters/OpenAIAdapter.ts` — OpenAI REST
4. `src/embedding/HNSWIndex.ts` — usearch wrapper
5. `src/embedding/MultimodalEmbedder.ts` — fusion logic

### Step 9: Entity Resolution (Days 9–10)
1. `src/entity/AliasIndex.ts`
2. `src/entity/NodeResolutionService.ts`
3. Write entity unit tests

### Step 10: Bootstrap (Days 11–12)
1. `src/bootstrap/StagedMutations.ts`
2. `src/bootstrap/HypothesisManager.ts`
3. `src/bootstrap/GraphConstructor.ts`
4. `src/bootstrap/BootstrapProtocol.ts`
5. Write bootstrap unit tests

### Step 11: Barrel + Convergence Test (Days 13–14)
1. `src/index.ts` — export everything public
2. Write and pass `tests/convergence/convergence.test.ts`

---

## Critical Algorithms

### Weight Propagation (implement exactly — do NOT deviate)

```typescript
// In WeightPropagation.ts

// Margin-based influence — prevents rich-get-richer
private computeInfluence(edge: GraphEdge, competing: GraphEdge[]): number {
  if (competing.length === 0) return 1.0
  const maxCompetitor = Math.max(...competing.map(e => e.weight))
  const margin = edge.weight - maxCompetitor
  const rawInfluence = Math.max(0.1, margin / edge.weight)
  const minInfluence = 1.0 / (competing.length + 1)
  return Math.max(minInfluence, rawInfluence)
  // NOTE: NO selection_bonus multiplier — this was an earlier design, removed
}

// Adaptive step discount — base MUST be 0.85, not 0.6
computeDiscount(step: StepLedger, stepIndex: number): number {
  const baseDiscount = Math.pow(0.85, stepIndex)
  if (step.has_sub_outcome) return baseDiscount * 0.5
  return baseDiscount
}

// Credit formula
computeCredit(
  outcomeSignal: number,    // -1.0 to 1.0
  influence: number,
  discount: number
): number {
  return outcomeSignal * influence * discount
}

// Apply credit to edge weight
applyCredit(currentWeight: number, credit: number): number {
  const newWeight = currentWeight + credit * 0.1   // learning rate 0.1
  return Math.max(0.0, Math.min(1.0, newWeight))   // clamp to [0, 1]
}

// Full propagation for a completed trace
async propagate(
  steps: StepLedger[],
  outcome: OutcomeSignal,
  graph: KnowledgeGraph
): Promise<PropagationResult[]> {
  const results: PropagationResult[] = []
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    const edge = await graph.getEdge(step.edge_id)
    if (!edge || edge.locked) continue

    // Get competing edges from same source node
    const sibling_edges = await graph.getEdgesByNode(edge.from_node, 'from')
    const competing = sibling_edges.filter(e => e.id !== edge.id)

    const influence = this.computeInfluence(edge, competing)
    const discount  = this.computeDiscount(step, i)
    const credit    = this.computeCredit(outcome.value, influence, discount)
    const newWeight = this.applyCredit(edge.weight, credit)

    await this.updater.update(edge.id, edge.weight, newWeight, 'propagation', outcome.trace_id)
    results.push({ edge_id: edge.id, old_weight: edge.weight, new_weight: newWeight,
                   delta: newWeight - edge.weight, credit, influence, discount })
  }
  return results
}
```

### Decay Scheduler (implement exactly)

```typescript
// In DecayScheduler.ts

// Run every 6 hours
// Grace period: skip if last_traversed within 48 hours
// Max deferral: 24 hours (if decay was deferred, force-run after 24h)
// Decay toward 0.5 (not toward 0)

private GRACE_MS        = 48 * 60 * 60 * 1000   // 48 hours
private MAX_DEFERRAL_MS = 24 * 60 * 60 * 1000   // 24 hours
private INTERVAL_MS     = 6  * 60 * 60 * 1000   // 6 hours
private MAX_DELTA       = 0.05                   // cap per cycle

async decayEdge(edge: GraphEdge, now: number): Promise<number | null> {
  if (edge.locked) return null
  const lastTraversed = edge.last_traversed ?? edge.created_at
  const age = now - lastTraversed
  if (age < this.GRACE_MS) return null   // within grace, skip

  const hoursElapsed = age / (60 * 60 * 1000)
  const distanceFromNeutral = Math.abs(edge.weight - 0.5)
  const rawDelta = edge.decay_rate * distanceFromNeutral * hoursElapsed
  const cappedDelta = Math.min(rawDelta, this.MAX_DELTA)

  // Move toward 0.5
  const direction = edge.weight > 0.5 ? -1 : 1
  const newWeight = edge.weight + direction * cappedDelta

  // Clamp — never cross 0.5 in a single step
  const clamped = direction > 0
    ? Math.min(newWeight, 0.5)
    : Math.max(newWeight, 0.5)

  return clamped
}

async runCycle(graph: KnowledgeGraph, now = Date.now()): Promise<void> {
  const edges = graph.getAllEdges()
  for (const edge of edges) {
    const newWeight = await this.decayEdge(edge, now)
    if (newWeight !== null && newWeight !== edge.weight) {
      await this.updater.update(edge.id, edge.weight, newWeight, 'decay', undefined)
    }
  }
  this.lastRun = now
}
```

### OCC Compare-and-Swap

```typescript
// In EdgeWeightUpdater.ts + SQLiteAdapter.ts

// SQLiteAdapter:
updateEdgeWeight(id: string, newWeight: number, expectedWeight: number): boolean {
  const stmt = this.db.prepare(
    `UPDATE edges SET weight = ? WHERE id = ? AND weight = ?`
  )
  const result = stmt.run(newWeight, id, expectedWeight)
  return result.changes === 1   // 0 = OCC miss, 1 = success
}

// EdgeWeightUpdater:
async update(
  edgeId: string,
  expectedWeight: number,
  newWeight: number,
  reason: string,
  traceId?: string
): Promise<boolean> {
  const delays = [1, 2, 4]  // ms
  let currentExpected = expectedWeight

  for (let attempt = 0; attempt <= 2; attempt++) {
    const success = this.adapter.updateEdgeWeight(edgeId, newWeight, currentExpected)
    if (success) {
      this.weightLog.insert({ edge_id: edgeId, old_weight: currentExpected,
                              new_weight: newWeight, delta: newWeight - currentExpected,
                              reason, trace_id: traceId, created_at: Date.now() })
      return true
    }
    // Re-read current weight for next attempt
    const edge = this.adapter.getEdge(edgeId)
    if (!edge) return false
    currentExpected = edge.weight

    if (attempt < 2) await sleep(delays[attempt])
  }

  // Emergency LWW fallback
  console.warn(`OCC conflict on edge ${edgeId} after 3 retries — LWW fallback`)
  this.adapter.db.prepare(`UPDATE edges SET weight = ? WHERE id = ?`).run(newWeight, edgeId)
  return true
}
```

### Bootstrap Mode

```typescript
// In BootstrapProtocol.ts

async shouldBootstrap(graph: KnowledgeGraph): Promise<boolean> {
  const count = graph.nodeCount()
  return count < 10
}

// GraphConstructor extracts structured reasoning from LLM
// Input: raw task string
// Output: StagedMutation with proposed nodes/edges

// Prompt template for LLM:
const BOOTSTRAP_PROMPT = `
Analyze the following task and produce a structured knowledge graph proposal.

Task: {task}

Respond ONLY in this format:
CONTEXT: <brief description of the domain context>
STRATEGY: <high-level strategy name>
PLAN: <step 1> | <step 2> | <step 3>
EXPECTED_OUTCOME: <what success looks like>
`
// Parse response into:
// - 1 CONTEXT node
// - 1 STRATEGY node
// - N STEP nodes (one per plan step)
// - 1 OUTCOME node
// Edges: CONTEXT -SUPPORTS-> STRATEGY, STRATEGY -LEADS_TO-> STEP (each),
//        STEP(last) -PRODUCES-> OUTCOME
// All as StagedMutation, NOT committed to live graph
```

### Convergence Test Setup

```typescript
// tests/convergence/convergence.test.ts

class SimulatedEnvironment {
  // Two competing strategies:
  // - founder_pitch: ground truth weight should converge to > 0.7
  // - champion_route: ground truth weight should converge to < 0.5

  // On each trace: pick strategy by epsilon-greedy, simulate outcome
  // founder_pitch: P(success) = 0.8, outcome_signal = +0.8
  // champion_route: P(success) = 0.2, outcome_signal = -0.4

  async runTrace(graph: KnowledgeGraph, policy: SelectionPolicy): Promise<OutcomeSignal> {
    const strategies = graph.getEdgesByType('strategy')
    const chosen = policy.select(strategies)
    const isFounderPitch = chosen.to_node_label === 'founder_pitch'
    const success = Math.random() < (isFounderPitch ? 0.8 : 0.2)
    return {
      value: success ? (isFounderPitch ? 0.8 : 0.4) : (isFounderPitch ? -0.2 : -0.4),
      type: 'explicit',
      trace_id: crypto.randomUUID(),
      resolved_at: Date.now()
    }
  }
}

it('converges to optimal strategy in 50 traces', async () => {
  const env = new SimulatedEnvironment()
  // Run 50 traces
  for (let i = 0; i < 50; i++) {
    const signal = await env.runTrace(graph, policy)
    await propagation.propagate(env.lastSteps, signal, graph)
  }
  const founderEdge = graph.getEdgeByLabel('founder_pitch')
  const championEdge = graph.getEdgeByLabel('champion_route')
  expect(founderEdge.weight).toBeGreaterThan(0.7)
  expect(championEdge.weight).toBeLessThan(0.5)
}, 30_000)
```

---

## SQLite Schema (exact DDL)

```sql
-- Run in SQLiteAdapter constructor (CREATE TABLE IF NOT EXISTS)
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  graph_id TEXT NOT NULL,
  label TEXT NOT NULL,
  type TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  visit_count INTEGER NOT NULL DEFAULT 1,
  metadata TEXT NOT NULL DEFAULT '{}',
  subgraph_id TEXT,
  embedding BLOB,
  embedding_model TEXT,
  embedding_at INTEGER
);

CREATE TABLE IF NOT EXISTS node_content (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS edges (
  id TEXT PRIMARY KEY,
  graph_id TEXT NOT NULL,
  from_node TEXT NOT NULL REFERENCES nodes(id),
  to_node TEXT NOT NULL REFERENCES nodes(id),
  type TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 0.5,
  locked INTEGER NOT NULL DEFAULT 0,
  decay_rate REAL NOT NULL DEFAULT 0.001,
  created_at INTEGER NOT NULL,
  last_traversed INTEGER,
  traversal_count INTEGER NOT NULL DEFAULT 0,
  metadata TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS weight_events (
  id TEXT PRIMARY KEY,
  edge_id TEXT NOT NULL REFERENCES edges(id),
  old_weight REAL NOT NULL,
  new_weight REAL NOT NULL,
  delta REAL NOT NULL,
  reason TEXT NOT NULL,
  trace_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS traces (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  input TEXT NOT NULL,
  plan TEXT NOT NULL,
  outcome_signal REAL,
  outcome_type TEXT,
  resolved_at INTEGER,
  deferred INTEGER NOT NULL DEFAULT 0,
  deferred_until INTEGER,
  created_at INTEGER NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS aliases (
  alias TEXT NOT NULL,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  confidence REAL NOT NULL DEFAULT 1.0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (alias, node_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_nodes_graph_type ON nodes(graph_id, type);
CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_node);
CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_node);
CREATE INDEX IF NOT EXISTS idx_edges_graph ON edges(graph_id);
CREATE INDEX IF NOT EXISTS idx_weight_events_edge ON weight_events(edge_id);
CREATE INDEX IF NOT EXISTS idx_weight_events_trace ON weight_events(trace_id);
CREATE INDEX IF NOT EXISTS idx_aliases_alias ON aliases(alias);
CREATE INDEX IF NOT EXISTS idx_traces_session ON traces(session_id);
```

---

## External Dependencies

### packages/core/package.json dependencies
```json
{
  "dependencies": {
    "better-sqlite3": "^9.4.3",
    "usearch": "^2.12.0",
    "uuid": "^9.0.0",
    "zod": "^3.22.4"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.8",
    "@types/uuid": "^9.0.7",
    "vitest": "^1.4.0",
    "typescript": "^5.4.0"
  }
}
```

### Root devDependencies
```json
{
  "devDependencies": {
    "turbo": "^1.13.0",
    "typescript": "^5.4.0",
    "vitest": "^1.4.0",
    "@biomejs/biome": "^1.6.0"
  }
}
```

### Embedding (optional runtime, lazy-loaded)
- Ollama must be running locally for NomicAdapter (checked at runtime, not install time)
- OpenAIAdapter requires `OPENAI_API_KEY` env var (checked at runtime)
- All embedding adapters must degrade gracefully (no embedding = null in DB, HNSW search skipped)

---

## Acceptance Criteria (Testable)

1. **Install**: `pnpm install` completes without errors, all workspace links resolve.
2. **Unit tests pass**: `pnpm test --filter=@0agent/core` — all tests green.
3. **Convergence**: After 50 simulated traces, `founder_pitch` edge weight > 0.7 AND `champion_route` edge weight < 0.5.
4. **CRUD**: Create node → read back → update last_seen → delete → confirm gone. Verified via SQLite directly.
5. **OCC**: Concurrent weight update with mismatched expected weight returns false and retries; final weight is consistent.
6. **Decay**: Edge with weight 0.8, no traversal for 48+ hours → weight moves toward 0.5 after `decayEdge()` call.
7. **Decay does NOT cross 0.5**: Edge at 0.48 decays toward 0.5 (upward), never overshoots to 0.52+.
8. **Locked edges not decayed**: `edge.locked = true` → `decayEdge()` returns null.
9. **Bootstrap triggers**: Graph with 9 nodes → `shouldBootstrap()` returns true; 10 nodes → false.
10. **StagedMutation TTL**: Mutation created 14+ days ago → `HypothesisManager.pruneExpired()` removes it.
11. **NodeResolution dedup**: Inserting two nodes with same label → `NodeResolutionService` returns same ID.
12. **Alias fuzzy**: Alias "acme" resolves to node "Acme Corp" with confidence ≥ 0.9.
13. **Step discount**: Step at index 3 with `has_sub_outcome=false` → discount = 0.85^3 = ~0.614. With `has_sub_outcome=true` → 0.614 * 0.5 = ~0.307.
14. **Influence floor**: With 4 competing edges, `minInfluence = 1/(4+1) = 0.2` is the floor.

---

## Risks and Gotchas

1. **better-sqlite3 is synchronous** — This is intentional and correct for Bun/Node single-threaded use. Do NOT wrap in async. All `SQLiteAdapter` methods are sync. The `EdgeWeightUpdater` async wrapper exists only for the retry backoff sleeps.

2. **usearch HNSW mmap** — The HNSW index file must be saved to a deterministic path (e.g., `~/.0agent/hnsw.bin`). If the index file doesn't exist on first `HNSWIndex.open()`, create a new empty index. If embedding dimensions change between runs, detect and rebuild.

3. **OCC and WAL mode** — SQLite WAL mode allows one writer at a time. The OCC retry loop is for application-level concurrency (multiple JS coroutines), not multi-process. Set `busy_timeout=5000` to handle the rare case of two processes.

4. **Convergence test determinism** — The convergence test uses `Math.random()`. Seed it with a fixed value (`Math.seedrandom('42')` or inject a seeded RNG) so the test is deterministic and not flaky. Use `vitest`'s `vi.spyOn(Math, 'random')` with a sequence.

5. **Decay formula precision** — `distance_from_0.5` is `Math.abs(weight - 0.5)`. If weight IS exactly 0.5, delta = 0. The decay must never push a weight past 0.5 — use the direction clamp or `Math.min`/`Math.max`.

6. **Bootstrap LLM dependency** — `GraphConstructor` calls an LLM. In unit tests, inject a mock LLM interface. The constructor must accept an `ILLMClient` parameter (do not hardcode model). Define `ILLMClient { complete(prompt: string): Promise<string> }` in Phase 1.

7. **Embedding null safety** — All code paths that use embeddings must check for null. `querySemantic` should return empty array if HNSW index has no entries, not throw.

8. **`index.ts` barrel exports** — Export only public API from `index.ts`. Internal implementation details (SQLiteAdapter internals, prepared statement objects) must NOT be exported. This keeps Phase 2's daemon import surface clean.

9. **TypeScript `strict: true`** — Enable all strict flags. This will catch `undefined` bugs in graph traversal early. Do not suppress errors with `!` assertions; handle nulls explicitly.

10. **better-sqlite3 binary for Bun** — better-sqlite3 ships a Node.js native addon. With Bun, use `bun:sqlite` instead (it's built-in and faster). Decide at package.json time: use `bun:sqlite` as the primary adapter and provide a `BetterSQLite3Adapter` as the Node.js fallback. This avoids native binding issues.

---

## Integration Points with Later Phases

- **Phase 2 (Daemon)**: Imports `KnowledgeGraph`, `WeightPropagation`, `DecayScheduler`, `TraceStore` from `@0agent/core`. The `DecayScheduler` will be driven by a `BackgroundWorker` timer in the daemon; in Phase 1 it is only tested via direct calls.
- **Phase 3 (Subagents)**: The `KnowledgeGraph` is read (never written) inside subagent sandbox via `GraphReadScope`. The `HNSWIndex` must support serialization for injection into sandbox.
- **Phase 4 (Learning Pipeline)**: `WeightPropagation`, `TraceStore`, `WeightEventLog` are all extended in Phase 4 with `CreditAttribution` and `DeferredTrace`. Design the interfaces to be extensible (do not make `propagate()` a private method).
- **Phase 5 (Compaction)**: `SQLiteAdapter` will need new methods for bulk edge queries (for pruning) and node deduplication. Add `getAllEdges(graph_id)` and `getNodesByEmbedding(threshold)` stubs now even if not implemented.
