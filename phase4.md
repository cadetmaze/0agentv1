# Phase 4: Learning Pipeline + Dashboard (Weeks 12–15)

## Goal

Complete the end-to-end learning loop: entity resolution → context activation → graph query → plan selection → subagent delegation → outcome collection → 3-layer credit attribution → weight update. Implement deferred traces (outcome verified later by a background verifier). Build the SvelteKit dashboard with real-time graph visualization, trace browser, entity explorer, and subagent monitor. After 100 real traces, plan selection accuracy must measurably improve.

---

## Complete File List

### packages/core additions
| File | Responsibility |
|------|---------------|
| `src/engine/InferenceEngine.ts` | End-to-end pipeline: resolve entities → query graph → select plan → delegate → attribute |
| `src/engine/CreditAttribution.ts` | 3-layer attribution: execution log → contribution weighting → DAG credit assignment |
| `src/trace/OutcomeTrace.ts` | Full immutable trace schema with all fields |
| `src/trace/TraversalLedger.ts` | 2-tier traversal logging: scan-only vs attribution-grade |
| `src/trace/DeferredTrace.ts` | Open/resolve/expire/bulk-resolve deferred outcome traces |
| `src/trace/TraceReplay.ts` | Replay graph query against historical snapshot state |
| `src/entity/EntityResolutionPipeline.ts` | 4-stage pipeline: extraction → graph lookup → disambiguation → context activation |
| `src/entity/ContextActivator.ts` | Keyword + semantic + entity-adjacent (2-hop) + recency boost activation |
| `src/entity/MCPEnrichedResolver.ts` | Stage CRM/tool enrichment, merge into graph before resolution |
| `src/memory/WorkingMemory.ts` | Active session context: bounded LRU cache of recently accessed nodes |
| `src/memory/BlinkingMemory.ts` | Mid-term prose-only compressed session summaries |
| `src/memory/ArchivalMemory.ts` | Long-term compressed summaries, stored in ObjectStore |
| `src/trace/SkillTraceDecorator.ts` | Decorates every skill invocation trace with `metadata.skill_name`, enables `0agent trace list --skill <name>` filtering |

### packages/dashboard
| File | Responsibility |
|------|---------------|
| `package.json` | `@0agent/dashboard`, SvelteKit, D3.js, deps |
| `svelte.config.js` | SvelteKit config: SPA mode (`adapter-static`), no SSR |
| `vite.config.ts` | Vite config with SvelteKit plugin |
| `src/app.html` | Root HTML shell |
| `src/routes/+layout.svelte` | Root layout: WS connection, global store, nav sidebar |
| `src/routes/+page.svelte` | Index: session list + quick task input |
| `src/routes/graph/+page.svelte` | D3 force-directed graph explorer |
| `src/routes/traces/+page.svelte` | Trace browser with filters |
| `src/routes/entities/+page.svelte` | Entity list + subgraph viewer |
| `src/routes/subagents/+page.svelte` | Active subagent monitor + noVNC embed |
| `src/routes/settings/+page.svelte` | Config editor (reads/writes via daemon API) |
| `src/routes/skills/+page.svelte` | Skill list: all skills with execution count, avg signal, last run |
| `src/routes/skills/[name]/+page.svelte` | Skill detail: execution history, signal trend chart, current edge weights |
| `src/routes/workflow/+page.svelte` | D3 visualization of sprint workflow graph with current weights, animated when a skill runs |
| `src/lib/stores/skills.ts` | Svelte store for skill execution data, signal history |
| `src/lib/components/WorkflowGraph.svelte` | D3 directed graph of sprint workflow with weighted edges, animated transitions on skill execution |
| `src/lib/components/SkillCard.svelte` | Single skill card: name, execution count, avg signal, last run timestamp |
| `src/lib/components/SignalTrendChart.svelte` | D3 line chart for skill signal trends over time |
| `src/lib/stores/graph.ts` | Svelte store for graph nodes/edges |
| `src/lib/stores/sessions.ts` | Svelte store for sessions |
| `src/lib/stores/ws.ts` | WebSocket connection + event dispatching |
| `src/lib/components/GraphViewer.svelte` | D3 force-directed graph component |
| `src/lib/components/TraceCard.svelte` | Single trace card with outcome signal |
| `src/lib/components/EntityPanel.svelte` | Entity detail + subgraph mini-view |
| `src/lib/components/SubagentVNC.svelte` | noVNC iframe embed with token auth |
| `src/lib/components/TaskInput.svelte` | Task submission form with streaming output |
| `src/lib/api.ts` | Typed fetch wrappers for all daemon REST routes |

---

## Key Interfaces and Types

```typescript
// src/trace/OutcomeTrace.ts — immutable, written once at trace close

export interface OutcomeTrace {
  // Identity
  id: string
  session_id: string
  created_at: number
  resolved_at?: number

  // Input
  input: string
  extracted_entities: string[]   // node IDs
  activated_context: string[]    // node IDs of activated context

  // Execution
  plan_edges: string[]           // edge IDs traversed in plan selection
  subagent_id?: string
  subagent_task_type?: TaskType

  // Outcome
  outcome_signal?: number        // -1.0 to 1.0
  outcome_type?: 'explicit' | 'implicit' | 'deferred' | 'expired' | 'learning_signal'
  deferred: boolean
  deferred_verifier?: string

  // Attribution
  attribution_results: AttributionResult[]

  // Metadata
  llm_calls: number
  tokens_used: number
  duration_ms: number
  metadata: Record<string, unknown>
  // Skill execution tracing: set when trace originates from a skill invocation
  // Enables filtering: `0agent trace list --skill review`
  // metadata.skill_name?: string
  // metadata.sprint_period?: string   // set for sprint-scoped skills
}

export interface AttributionResult {
  edge_id: string
  tier: 'scan_only' | 'attribution_grade'
  credit: number
  influence: number
  discount: number
  old_weight: number
  new_weight: number
}
```

```typescript
// src/trace/TraversalLedger.ts

export interface TraversalEntry {
  edge_id: string
  traversed_at: number
  step_index: number
  tier: 'scan_only' | 'attribution_grade'
  weight_at_traversal: number
  competing_edge_weights: number[]   // weights of sibling edges at traversal time
  has_sub_outcome: boolean
}

// Tier determination:
// - attribution_grade: weight difference vs best competitor > 0.1
// - scan_only: all others (browsed but not decisively selected)

export class TraversalLedger {
  private entries: TraversalEntry[] = []

  record(edge: GraphEdge, stepIndex: number, siblings: GraphEdge[]): void {
    const bestCompetitor = siblings.reduce((max, e) => Math.max(max, e.weight), 0)
    const tier: TraversalEntry['tier'] = (edge.weight - bestCompetitor) > 0.1
      ? 'attribution_grade'
      : 'scan_only'
    this.entries.push({
      edge_id:                  edge.id,
      traversed_at:             Date.now(),
      step_index:               stepIndex,
      tier,
      weight_at_traversal:      edge.weight,
      competing_edge_weights:   siblings.map(s => s.weight),
      has_sub_outcome:          false,  // updated when sub-outcome arrives
    })
  }

  getAttributionGrade(): TraversalEntry[] {
    return this.entries.filter(e => e.tier === 'attribution_grade')
  }

  toStepLedgers(): StepLedger[] {
    return this.entries.map(e => ({
      edge_id:         e.edge_id,
      step_index:      e.step_index,
      has_sub_outcome: e.has_sub_outcome,
      weight_at_traversal: e.weight_at_traversal,
    }))
  }
}
```

```typescript
// src/trace/DeferredTrace.ts

export interface DeferredTrace {
  trace_id: string
  verifier: string           // logical name, e.g. "email_replied", "task_completed"
  check_interval_ms: number
  ttl_ms: number             // max wait before expiry (neutral 0.0 signal)
  check_fn: () => Promise<OutcomeSignal | null>
  created_at: number
  last_checked_at?: number
  resolved: boolean
}

export interface DeferredTraceStore {
  open(trace: DeferredTrace): void
  resolve(trace_id: string, signal: number, type: OutcomeSignal['type']): Promise<void>
  expire(trace_id: string): Promise<void>   // resolve with signal 0.0, type 'expired'
  bulkResolveByVerifier(verifier: string, signal: number): Promise<number>  // returns count
  getPending(): DeferredTrace[]
  getExpired(now: number): DeferredTrace[]  // created_at + ttl_ms < now
}

// /retro skill — special outcome type: learning_signal
// The /retro skill outputs steps[].signal — each signal is a learning signal
// for a specific skill's trace during a sprint period.
export interface RetroOutput {
  sprint_id: string
  steps: RetroStep[]
}

export interface RetroStep {
  skill_name: string          // which skill this signal is for
  signal: number              // -1.0 to 1.0
  rationale: string           // why this signal value
  sprint_period: string       // e.g., "2026-03-17..2026-03-24"
}

// DeferredTraceResolver must handle outcome.type: 'learning_signal' by:
//   1. Reading the retro output JSON (RetroOutput)
//   2. For each steps[] entry, finding the matching trace (by skill_name + sprint_period)
//   3. Resolving those traces with the signal value
//   4. Running WeightPropagation on the resolved traces
```

```typescript
// src/entity/EntityResolutionPipeline.ts

export interface ExtractionResult {
  entities: Array<{
    text: string          // extracted entity text
    type: NodeType        // best-guess type from extraction
    confidence: number
  }>
}

export interface PipelineResult {
  resolved_entities: Array<{
    node_id: string
    original_text: string
    match_type: 'exact' | 'alias' | 'fuzzy' | 'created' | 'disambiguated'
    confidence: number
  }>
  activated_context: string[]  // node IDs
}

export interface IEntityExtractor {
  extract(text: string): Promise<ExtractionResult>
}
```

```typescript
// src/entity/ContextActivator.ts

export interface ActivationConfig {
  keyword_weight: number      // 1.0
  semantic_weight: number     // 0.8
  adjacent_weight: number     // 0.6
  recency_weight: number      // 0.4
  top_k: number               // 10
}

export interface ActivationScore {
  node_id: string
  score: number
  reasons: Array<'keyword' | 'semantic' | 'adjacent' | 'recency'>
}
```

```typescript
// src/engine/InferenceEngine.ts

export interface InferenceRequest {
  input: string
  session_id: string
  context?: Record<string, unknown>
  timeout_ms?: number
}

export interface InferenceResult {
  output: string
  trace_id: string
  entities_resolved: string[]
  plan_selected: string[]    // edge IDs
  subagent_result?: SubagentResult
  outcome_signal?: number
  deferred: boolean
}

export interface IInferenceEngine {
  infer(req: InferenceRequest): Promise<InferenceResult>
}
```

```typescript
// src/engine/CreditAttribution.ts

export interface DAGNode {
  edge_id: string
  parents: string[]
  children: string[]
  base_credit: number       // before DAG propagation
  final_credit: number      // after backward pass
}

export interface AttributionConfig {
  competing_edge_penalty: number   // -0.3 (competing edges get credit * -0.3)
  ambiguity_split: number          // 0.5 (split equally if paths tie)
  min_attribution_grade_delta: number  // 0.1 (tier threshold)
}
```

```typescript
// src/memory/WorkingMemory.ts

export interface WorkingMemoryConfig {
  max_nodes: number          // default 200
  eviction_policy: 'lru'    // only LRU supported
}

// LRU cache of GraphNode — on access, move to front
// On eviction: node stays in SQLite, only removed from in-memory cache
// This is a performance layer over the SQLite graph, not a separate store
```

---

## Critical Algorithms

### Entity Resolution Pipeline (4 stages, implement exactly)

```typescript
// EntityResolutionPipeline.ts

async resolve(input: string, session_context: WorkingMemory): Promise<PipelineResult> {

  // STAGE 1: Extraction
  // Use LLM to extract named entities with types
  const extraction = await this.extractor.extract(input)
  // e.g., "Research Acme Corp funding" → [{ text: "Acme Corp", type: ENTITY, confidence: 0.95 }]

  // STAGE 2: Graph Lookup
  const candidates: Map<string, ResolutionCandidate[]> = new Map()
  for (const entity of extraction.entities) {
    const candidates_for_entity: ResolutionCandidate[] = []

    // 2a. Exact label match (confidence = 1.0)
    const exact = this.graph.findNodeByLabel(entity.text)
    if (exact) {
      candidates_for_entity.push({ node_id: exact.id, confidence: 1.0, match_type: 'exact' })
    }

    // 2b. Alias match (confidence = 0.9)
    const aliases = this.aliasIndex.findByAlias(entity.text)
    for (const alias of aliases) {
      if (alias.confidence >= 0.9) {
        candidates_for_entity.push({ node_id: alias.node_id, confidence: alias.confidence, match_type: 'alias' })
      }
    }

    // 2c. Fuzzy semantic search (confidence = cosine similarity)
    if (this.embedder) {
      const vec = await this.embedder.embed({ type: ContentType.TEXT, data: entity.text })
      const results = this.hnsw.search(vec, 5)  // top 5
      for (const r of results) {
        if (r.score >= 0.65) {
          candidates_for_entity.push({ node_id: r.node_id, confidence: r.score, match_type: 'fuzzy' })
        }
      }
    }

    // 2d. If NO candidates above 0.65: mark for creation
    if (candidates_for_entity.length === 0) {
      candidates_for_entity.push({ node_id: '__create__', confidence: 0.0, match_type: 'created' })
    }

    candidates.set(entity.text, candidates_for_entity)
  }

  // STAGE 3: Disambiguation
  // If multiple candidates for same entity, use context to pick
  const resolved: PipelineResult['resolved_entities'] = []
  for (const [text, cands] of candidates) {
    if (cands.length === 1 && cands[0].node_id === '__create__') {
      // Create new entity node
      const newNode = await this.graph.addNode({
        label: text,
        type: NodeType.ENTITY,
        graph_id: this.graph_id,
        // ...
      })
      resolved.push({ node_id: newNode.id, original_text: text, match_type: 'created', confidence: 1.0 })
      continue
    }

    // Pick highest confidence candidate
    const best = cands.sort((a, b) => b.confidence - a.confidence)[0]
    if (best.confidence >= 0.80) {
      resolved.push({ ...best, original_text: text })
    } else {
      // Disambiguation required: use session context to break tie
      const disambiguated = await this.disambiguate(text, cands, session_context)
      resolved.push({ node_id: disambiguated.node_id, original_text: text,
                       match_type: 'disambiguated', confidence: disambiguated.confidence })
    }
  }

  // STAGE 4: Context Activation
  const activated = await this.contextActivator.activate(
    resolved.map(r => r.node_id),
    input,
    session_context
  )

  return { resolved_entities: resolved, activated_context: activated }
}
```

### Context Activation

```typescript
// ContextActivator.ts

async activate(
  entity_ids: string[],
  input: string,
  working_memory: WorkingMemory
): Promise<string[]> {
  const scores = new Map<string, ActivationScore>()

  // Method 1: Keyword match (weight 1.0)
  const inputTokens = tokenize(input)   // simple word tokenization
  const allNodes = this.graph.queryNodes(this.graph_id)
  for (const node of allNodes) {
    const labelTokens = tokenize(node.label)
    const overlap = inputTokens.filter(t => labelTokens.includes(t)).length
    if (overlap > 0) {
      addScore(scores, node.id, overlap * 1.0, 'keyword')
    }
  }

  // Method 2: Semantic similarity (weight 0.8)
  if (this.embedder) {
    const queryVec = await this.embedder.embed({ type: ContentType.TEXT, data: input })
    const semantic = this.hnsw.search(queryVec, 20)
    for (const r of semantic) {
      addScore(scores, r.node_id, r.score * 0.8, 'semantic')
    }
  }

  // Method 3: Entity-adjacent — 2-hop neighbors of resolved entities (weight 0.6)
  for (const entity_id of entity_ids) {
    const neighbors1 = this.graph.getEdgesByNode(entity_id, 'both').map(e =>
      e.from_node === entity_id ? e.to_node : e.from_node
    )
    for (const n1 of neighbors1) {
      addScore(scores, n1, 0.6, 'adjacent')
      // Second hop
      const neighbors2 = this.graph.getEdgesByNode(n1, 'both').map(e =>
        e.from_node === n1 ? e.to_node : e.from_node
      )
      for (const n2 of neighbors2) {
        addScore(scores, n2, 0.6 * 0.5, 'adjacent')   // half weight for 2nd hop
      }
    }
  }

  // Method 4: Recency boost (weight 0.4)
  const recent = working_memory.getRecentNodes(20)
  for (const node of recent) {
    addScore(scores, node.id, 0.4, 'recency')
  }

  // Sort by total score, return top_k node IDs
  return Array.from(scores.entries())
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, this.config.top_k)
    .map(([node_id]) => node_id)
}
```

### 3-Layer Credit Attribution (implement exactly)

```typescript
// CreditAttribution.ts

async attribute(
  ledger: TraversalLedger,
  outcome: OutcomeSignal,
  graph: KnowledgeGraph
): Promise<AttributionResult[]> {

  // LAYER 1: Execution Log
  // Get all traversal entries; separate by tier
  const all_entries = ledger.toStepLedgers()
  const attribution_grade = ledger.getAttributionGrade()
  // scan_only entries: record traversal but credit = 0 (no weight update)

  // LAYER 2: Contribution Weighting
  // For each attribution-grade entry, compute base credit
  const base_credits = new Map<string, number>()
  for (const entry of attribution_grade) {
    const edge = await graph.getEdge(entry.edge_id)
    if (!edge) continue

    const siblings = await graph.getEdgesByNode(edge.from_node, 'from')
    const competing = siblings.filter(s => s.id !== edge.id)
    const influence = this.propagation.computeInfluence(edge, competing)
    const discount  = this.propagation.computeDiscount(entry, entry.step_index)
    const credit    = outcome.value * influence * discount

    base_credits.set(entry.edge_id, credit)
  }

  // LAYER 3: DAG Credit Assignment
  // Build DAG of contributing paths
  const dag = this.buildDAG(attribution_grade, base_credits)

  // Forward pass: identify all paths that contributed
  // (paths where each step's credit > 0 are "contributing")

  // Backward pass: assign final credits
  const final_credits = this.backwardPass(dag)

  // Apply competing edge penalty
  const results: AttributionResult[] = []
  for (const [edge_id, base_credit] of base_credits) {
    const final = final_credits.get(edge_id) ?? base_credit
    results.push({
      edge_id,
      tier: 'attribution_grade',
      credit: final,
      influence: 0,    // already embedded in credit
      discount: 0,
      old_weight: 0,   // filled in by propagation
      new_weight: 0,
    })
  }

  // Competing edges (sibling edges not selected) get inverse credit
  for (const entry of attribution_grade) {
    const edge = await graph.getEdge(entry.edge_id)
    if (!edge) continue
    const siblings = await graph.getEdgesByNode(edge.from_node, 'from')
    const competing = siblings.filter(s => s.id !== edge.id)
    for (const comp of competing) {
      const selected_credit = base_credits.get(entry.edge_id) ?? 0
      results.push({
        edge_id: comp.id,
        tier: 'attribution_grade',
        credit: selected_credit * -0.3,   // EXACT: -0.3 penalty
        influence: 0,
        discount: 0,
        old_weight: comp.weight,
        new_weight: 0,
      })
    }
  }

  return results
}

private backwardPass(dag: Map<string, DAGNode>): Map<string, number> {
  const final = new Map<string, number>()
  for (const [edge_id, node] of dag) {
    // Ambiguity: if two or more paths equally likely, split 50/50
    const parents_count = node.parents.length
    if (parents_count > 1) {
      // Equal parents → split credit equally
      final.set(edge_id, node.base_credit / parents_count)
    } else {
      final.set(edge_id, node.base_credit)
    }
  }
  return final
}
```

### Deferred Trace Resolver (Background Worker)

```typescript
// BackgroundWorkers.ts — Phase 4 update

private async resolveDeferred(): Promise<void> {
  const pending = this.deferredStore.getPending()
  for (const trace of pending) {
    const now = Date.now()

    // Check TTL expiry first
    if (now > trace.created_at + trace.ttl_ms) {
      await this.deferredStore.expire(trace.id)
      // Apply neutral signal (0.0) to weight propagation
      await this.applyOutcome(trace.trace_id, 0.0, 'expired')
      continue
    }

    // Check if it's time to poll
    const nextCheck = (trace.last_checked_at ?? trace.created_at) + trace.check_interval_ms
    if (now < nextCheck) continue

    // Run check function
    try {
      const signal = await trace.check_fn()
      if (signal !== null) {
        await this.deferredStore.resolve(trace.id, signal.value, signal.type)
        await this.applyOutcome(trace.trace_id, signal.value, signal.type)
      }
    } catch (err) {
      console.error(`Deferred check failed for trace ${trace.id}:`, err)
      // Do not expire on check error — retry at next interval
    }
  }
}

// Handle /retro skill's learning_signal outcome type
private async handleRetroLearningSignal(retro_trace_id: string, output: string): Promise<void> {
  const retroOutput: RetroOutput = JSON.parse(output)
  for (const step of retroOutput.steps) {
    // Find the matching trace by skill_name + sprint_period
    const matchingTraces = this.traceStore.findTraces({
      'metadata.skill_name': step.skill_name,
      'metadata.sprint_period': step.sprint_period,
    })
    for (const trace of matchingTraces) {
      // Resolve each matching trace with the retro signal
      await this.applyOutcome(trace.id, step.signal, 'learning_signal')
    }
  }
}

private async applyOutcome(trace_id: string, signal: number, type: string): Promise<void> {
  // Look up the trace's traversal ledger (stored in TraceStore as JSON blob)
  const trace = this.traceStore.getTrace(trace_id)
  if (!trace) return

  const ledger = TraversalLedger.fromJSON(trace.ledger_json)
  const outcome: OutcomeSignal = { value: signal, type: type as any, trace_id, resolved_at: Date.now() }
  const attribution = await this.attribution.attribute(ledger, outcome, this.graph)

  for (const attr of attribution) {
    const edge = await this.graph.getEdge(attr.edge_id)
    if (!edge || edge.locked) continue
    const newWeight = this.propagation.applyCredit(edge.weight, attr.credit)
    await this.updater.update(edge.id, edge.weight, newWeight, `attribution:${type}`, trace_id)
    this.eventBus.emit({ type: 'graph.weight_updated', edge_id: edge.id, old: edge.weight, new: newWeight })
  }
}
```

---

## Workflow Suggestion Engine

```typescript
// WorkflowSuggestionEngine.ts — recommends next skill based on graph weights

export class WorkflowSuggestionEngine {
  constructor(
    private readonly graph: KnowledgeGraph,
    private readonly skillRegistry: SkillRegistry
  ) {}

  // `0agent workflow suggest` — recommend next skill based on current context + weights
  async suggest(lastSkillName?: string): Promise<string | null> {
    if (!lastSkillName) return null

    // Find skill node in workflow graph
    const skillNode = this.graph.findNodeByLabel(lastSkillName)
    if (!skillNode) return null

    // Get outgoing edges from this skill node, sorted by weight descending
    const outEdges = await this.graph.getEdgesByNode(skillNode.id, 'from')
    const ranked = outEdges
      .filter(e => {
        const toNode = this.graph.getNode(e.to_node)
        return toNode?.metadata?.is_skill === true
      })
      .sort((a, b) => b.weight - a.weight)

    if (ranked.length === 0) return null

    // Return highest-weight successor skill
    const bestEdge = ranked[0]
    const bestNode = this.graph.getNode(bestEdge.to_node)
    return bestNode?.label ?? null
    // E.g., after `/build`, suggests `/review` (weight 0.90)
  }
}
```

---

## Dashboard Implementation

### Skill Dashboard Pages

```typescript
// /skills page — list all skills with execution stats
// Fetch from: GET /api/skills (returns SkillInfo[])
// Display: table with columns: Name, Execution Count, Avg Signal, Last Run
// Sort by: last run (default), execution count, avg signal
// Click row → navigate to /skills/:name

// /skills/:name page — skill detail
// Fetch from: GET /api/skills/:name (returns SkillDetail)
// Sections:
//   1. Execution history — table of last 50 invocations with timestamp, signal, duration
//   2. Signal trend chart — D3 line chart of signal values over time (SignalTrendChart.svelte)
//   3. Current edge weights — table of workflow edges connected to this skill node

// /workflow page — sprint workflow visualization
// Fetch from: GET /api/workflow/graph (returns nodes + edges with weights)
// D3 directed graph (WorkflowGraph.svelte):
//   - Nodes = skill names, colored by avg signal (green > 0.5, red < 0.5)
//   - Edge thickness = weight (thicker = stronger learned preference)
//   - Animated pulse on edge when a skill runs (via WS event: skill.executed)
//   - Tooltip on hover: weight value, traversal count, last traversed
```

### GraphViewer.svelte — D3 Force Graph

```typescript
// D3 force simulation setup (run in onMount)
// - Nodes colored by NodeType (enum → color map)
// - Edge thickness proportional to weight (weight * 3px)
// - Nodes sized by visit_count (log scale)
// - Double-click: open EntityPanel for that node
// - Hover: show tooltip with label + type + weight

const COLOR_MAP: Record<NodeType, string> = {
  entity:     '#4f9cf9',
  context:    '#7bc67e',
  strategy:   '#f5a623',
  plan:       '#9b59b6',
  step:       '#e74c3c',
  outcome:    '#2ecc71',
  signal:     '#f39c12',
  tool:       '#1abc9c',
  constraint: '#95a5a6',
  hypothesis: '#e67e22',
}

// On weight_updated WS event: animate edge thickness change
// On new node: add to simulation with entrance animation
// On deleted node: remove from simulation with exit animation
```

### WebSocket Store

```typescript
// src/lib/stores/ws.ts (Svelte store)
import { writable } from 'svelte/store'

export const wsStatus = writable<'connecting' | 'connected' | 'disconnected'>('disconnected')
export const lastEvent = writable<DaemonEvent | null>(null)

let ws: WebSocket | null = null

export function connectWS(): void {
  ws = new WebSocket('ws://localhost:4200/ws')
  ws.onopen = () => {
    wsStatus.set('connected')
    ws!.send(JSON.stringify({ type: 'subscribe', topics: ['sessions', 'graph', 'subagents', 'stats'] }))
  }
  ws.onmessage = (e) => {
    const event: DaemonEvent = JSON.parse(e.data)
    lastEvent.set(event)
    // Dispatch to relevant stores
    dispatchEvent(event)
  }
  ws.onclose = () => {
    wsStatus.set('disconnected')
    // Reconnect after 3s
    setTimeout(() => connectWS(), 3000)
  }
}
```

### SubagentVNC.svelte

```svelte
<script lang="ts">
  export let vnc_port: number
  export let subagent_id: string

  $: novnc_url = `http://localhost:${vnc_port}/vnc.html?autoconnect=1&resize=remote`
</script>

<!-- noVNC iframe embed -->
<div class="vnc-container">
  <iframe
    src={novnc_url}
    title="Subagent display - {subagent_id}"
    width="100%"
    height="600"
    frameborder="0"
  />
</div>
```

---

## Memory System

```typescript
// WorkingMemory.ts — LRU cache of GraphNode
// NOT a separate store — it is a read-through cache over SQLite

class WorkingMemory {
  private cache: Map<string, GraphNode>   // insertion-ordered Map = LRU
  private readonly max_nodes: number

  get(id: string): GraphNode | null {
    const node = this.cache.get(id)
    if (node) {
      // Move to end (most recently used)
      this.cache.delete(id)
      this.cache.set(id, node)
      return node
    }
    // Cache miss: load from graph
    const fromGraph = this.graph.getNode(id)
    if (fromGraph) this.put(fromGraph)
    return fromGraph
  }

  put(node: GraphNode): void {
    if (this.cache.size >= this.max_nodes) {
      // Evict LRU: first entry in Map
      const firstKey = this.cache.keys().next().value
      this.cache.delete(firstKey)
    }
    this.cache.set(node.id, node)
  }

  getRecentNodes(n: number): GraphNode[] {
    return Array.from(this.cache.values()).slice(-n)
  }
}

// BlinkingMemory — prose summary per session, compressed
// At session end: summarize last N steps with LLM, store in memory table
// Retrieved at next session start for context

// ArchivalMemory — long-term compressed summaries
// Written when BlinkingMemory exceeds a threshold (e.g., 50 sessions)
// Stored as ObjectStore file, referenced by metadata pointer in a node
```

---

## InferenceEngine — Full Pipeline

```typescript
// InferenceEngine.ts

async infer(req: InferenceRequest): Promise<InferenceResult> {
  const trace_id = crypto.randomUUID()
  const started = Date.now()

  // Initialize working memory + traversal ledger for this session
  const working_memory = this.memoryManager.getOrCreate(req.session_id)
  const ledger = new TraversalLedger()

  // Step 1: Entity Resolution
  const resolution = await this.resolutionPipeline.resolve(req.input, working_memory)
  const entity_ids = resolution.resolved_entities.map(r => r.node_id)

  // Step 2: Graph query — structural + semantic
  const query: GraphQuery = {
    entity_ids,
    context_ids: resolution.activated_context,
    limit: 20,
    semantic_query: req.input,
  }
  const { nodes, edges } = await this.graph.queryMerged(query)

  // Step 3: Plan selection via SelectionPolicy
  // Get strategy + plan edges from query results
  const strategy_edges = edges.filter(e => {
    const toNode = nodes.find(n => n.id === e.to_node)
    return toNode?.type === NodeType.STRATEGY || toNode?.type === NodeType.PLAN
  })

  const selected_edge = await this.policy.select(strategy_edges)
  if (!selected_edge) throw new Error('No plan edges available for task')

  // Record in traversal ledger
  ledger.record(selected_edge, 0, strategy_edges)

  // Step 4: Delegate to subagent
  const subagent_result = await this.orchestrator.spawn({
    session_id: req.session_id,
    task: req.input,
    task_type: inferTaskType(req.input),
    context: req.context,
    graph_snapshot: await this.graph.getSubGraph(entity_ids[0], 2),
  })

  // Step 5: Collect outcome signal
  // For now: treat subagent exit_reason as outcome proxy
  let outcome_signal: number | undefined
  let deferred = false

  if (subagent_result.exit_reason === 'completed') {
    // Implicit positive signal
    outcome_signal = 0.5
  } else if (subagent_result.exit_reason === 'error') {
    outcome_signal = -0.5
  } else {
    // Defer — outcome will be verified by a verifier
    deferred = true
    this.deferredStore.open({
      trace_id,
      verifier: 'task_completion_check',
      check_interval_ms: 60_000,
      ttl_ms: 24 * 60 * 60 * 1000,
      check_fn: () => checkTaskCompletion(subagent_result.output),
      created_at: Date.now(),
      resolved: false,
    })
  }

  // Step 6: Attribution + weight update (if outcome known now)
  if (!deferred && outcome_signal !== undefined) {
    const outcome: OutcomeSignal = {
      value: outcome_signal,
      type: 'implicit',
      trace_id,
      resolved_at: Date.now(),
    }
    const attribution_results = await this.attribution.attribute(ledger, outcome, this.graph)
    for (const attr of attribution_results) {
      const edge = await this.graph.getEdge(attr.edge_id)
      if (!edge || edge.locked) continue
      const newWeight = this.propagation.applyCredit(edge.weight, attr.credit)
      await this.updater.update(edge.id, edge.weight, newWeight, 'inference_attribution', trace_id)
      this.eventBus.emit({ type: 'graph.weight_updated', edge_id: edge.id, old: edge.weight, new: newWeight })
    }
  }

  // Step 6b: Skill execution tracing — decorate trace with skill_name if applicable
  const skill_name = req.context?.skill_name as string | undefined
  const traceMetadata: Record<string, unknown> = {}
  if (skill_name) {
    traceMetadata.skill_name = skill_name
    traceMetadata.sprint_period = req.context?.sprint_period
  }

  // Step 7: Save trace
  const trace: OutcomeTrace = {
    id: trace_id,
    session_id: req.session_id,
    created_at: started,
    resolved_at: deferred ? undefined : Date.now(),
    input: req.input,
    extracted_entities: entity_ids,
    activated_context: resolution.activated_context,
    plan_edges: [selected_edge.id],
    subagent_id: subagent_result.subagent_id,
    outcome_signal,
    outcome_type: deferred ? undefined : 'implicit',
    deferred,
    attribution_results: [],
    llm_calls: subagent_result.llm_calls_used,
    tokens_used: subagent_result.tokens_used,
    duration_ms: Date.now() - started,
    metadata: traceMetadata,
  }
  this.traceStore.insertTrace(trace)

  return {
    output: subagent_result.output,
    trace_id,
    entities_resolved: entity_ids,
    plan_selected: [selected_edge.id],
    subagent_result,
    outcome_signal,
    deferred,
  }
}
```

---

## Implementation Order

### Week 12 (Days 1–5): Tracing Infrastructure

1. **Day 1**: `OutcomeTrace.ts` — schema + SQLite persistence (extend TraceStore).
2. **Day 2**: `TraversalLedger.ts` — 2-tier logging, `toStepLedgers()`, tier determination logic.
3. **Day 3**: `DeferredTrace.ts` + `DeferredTraceStore` (SQLite-backed). Extend `BackgroundWorkers.ts` with full deferred resolver.
4. **Day 4**: `TraceReplay.ts` — snapshot-based replay (for debugging — reads weight_events to reconstruct historical state).
5. **Day 5**: Update `TraceStore.ts` to store ledger JSON blob alongside trace.

### Week 13 (Days 6–10): Entity + Attribution

6. **Day 6**: `EntityResolutionPipeline.ts` — 4 stages. Write unit test with mock graph.
7. **Day 7**: `ContextActivator.ts` — 4 activation methods. Unit test each method independently.
8. **Day 8**: `MCPEnrichedResolver.ts` — CRM enrichment staging (can be a stub calling FilesystemMCP or ShellMCP).
9. **Day 9**: `CreditAttribution.ts` — 3 layers. Write test: given deterministic ledger → expected credits.
10. **Day 10**: `InferenceEngine.ts` — wire all pieces together. Integration test with mock subagent.

### Week 14 (Days 11–15): Memory + Dashboard Build

11. **Day 11**: `WorkingMemory.ts` (LRU), `BlinkingMemory.ts` (prose compression), `ArchivalMemory.ts` (stub).
12. **Day 12**: Dashboard project setup: SvelteKit, D3, WS store.
13. **Day 13**: `GraphViewer.svelte` with D3 force simulation. Connect to live WS events.
14. **Day 14**: Trace browser page, entity explorer page.
15. **Day 15**: Subagent monitor + `SubagentVNC.svelte`. Settings page.

### Week 15 (Days 16–20): Integration + Accuracy Test + Skill Dashboard

16. **Day 16**: Daemon serves dashboard static files from `GET /` route. Build `SkillTraceDecorator` — wraps skill invocations with `metadata.skill_name`.
17. **Day 17**: Full pipeline integration test: submit task → see entities resolved → graph updates → trace stored. Add `/retro` `learning_signal` handler to `DeferredTraceResolver`.
18. **Day 18**: 100-trace accuracy test: measure plan selection hit rate before vs after. Build `/skills` and `/skills/:name` dashboard pages.
19. **Day 19**: Fix attribution bugs revealed by accuracy test. Build `/workflow` page with `WorkflowGraph.svelte` D3 directed graph. Implement `WorkflowSuggestionEngine`.
20. **Day 20**: Dashboard polish: edge animation on weight_updated events, skill execution pulse animation on workflow graph, responsive layout.

---

## External Dependencies

### packages/core (additions)
```json
{
  "dependencies": {
    "lru-cache": "^10.2.0"
  }
}
```

### packages/dashboard
```json
{
  "dependencies": {
    "@sveltejs/kit": "^2.5.0",
    "@sveltejs/adapter-static": "^3.0.1",
    "svelte": "^4.2.12",
    "d3": "^7.9.0",
    "vite": "^5.1.0"
  },
  "devDependencies": {
    "@types/d3": "^7.4.3",
    "typescript": "^5.4.0"
  }
}
```

---

## Acceptance Criteria (Testable)

1. **Full pipeline**: `inferenceEngine.infer({ input: "Research Acme Corp", session_id: "s1" })` returns `InferenceResult` with `entities_resolved` containing an "Acme Corp" node ID.
2. **Entity dedup in pipeline**: Run pipeline twice with same entity — same node ID returned both times.
3. **Deferred trace TTL**: Open deferred trace with `ttl_ms: 1000`, wait 2s → background worker resolves with signal 0.0, `outcome_type: 'expired'`.
4. **Deferred trace resolution**: Open deferred trace, manually call `deferredStore.resolve(id, 0.8, 'explicit')` → weight update applied.
5. **Bulk verifier resolve**: `deferredStore.bulkResolveByVerifier('email_replied', 0.7)` → all matching traces resolved, returns count.
6. **Attribution accuracy**: Given 3-step trace with `outcome_signal = 1.0`, step 0 is attribution-grade → step 0 edge gets positive credit; competing sibling edge gets `credit * -0.3`.
7. **Context activation**: Input "Acme Corp funding round" → ContextActivator returns adjacent nodes (entities connected to Acme Corp) in top results.
8. **TraversalLedger tier**: Edge with weight 0.7 vs competitor 0.5 → tier = 'attribution_grade' (delta = 0.2 > 0.1). Edge with weight 0.6 vs competitor 0.55 → tier = 'scan_only' (delta = 0.05 < 0.1).
9. **Working memory LRU**: Fill to 200 nodes, access node 1 (moves to front), insert node 201 → node 2 is evicted (was LRU), node 1 survives.
10. **Dashboard loads**: `curl http://localhost:4200/` returns HTML with `<div id="app">`.
11. **Graph WS update**: Submit task → WS client receives `graph.weight_updated` events within 5s.
12. **D3 graph renders**: Open `/graph` in browser → force-directed graph appears with colored nodes within 3s.
13. **Trace browser**: Open `/traces` → lists last 10 traces with outcome signal badges.
14. **Contradiction detection**: Two traces with same entities but opposite signals (one `+0.8`, one `-0.8`) → system logs a contradiction warning (not yet auto-resolved, just flagged).
15. **100-trace improvement**: Run 100 traces with known-optimal strategy in test env → strategy edge weight > 0.65 (up from initial 0.5).
16. **`/retro` feeds learning signals**: `/retro` skill output with `steps[].signal` values → `DeferredTraceResolver` finds matching skill traces by name + sprint period, resolves them with the signal, and runs `WeightPropagation` on the resolved traces. Edge weights update accordingly.
17. **Skill edge weight divergence**: After 5 sprints with `/retro` feedback, skill edge weights in the workflow graph visibly diverge from their initial seed values (delta > 0.1 from seed weight).
18. **Skill execution tracing**: Every skill invocation creates a trace with `metadata.skill_name` set. `0agent trace list --skill review` returns only traces where `metadata.skill_name === 'review'`.
19. **Dashboard skill pages**: `/skills` page lists all skills with execution count and avg signal. `/skills/review` shows execution history and signal trend chart. `/workflow` renders a D3 directed graph with current weights.
20. **Workflow suggestion**: `0agent workflow suggest` after running `/build` returns `/review` (highest-weight outgoing edge from `build` node in the workflow graph).

---

## Risks and Gotchas

1. **D3 + SvelteKit reactivity conflict** — D3 directly manipulates the DOM. Svelte's reactive compiler also manipulates the DOM. Use a single `<svg>` element as D3's mount point, with `onMount` and `onDestroy` to control D3's lifecycle. Never let Svelte re-render the SVG after D3 takes over. Pass data updates via D3 selection `.data()` calls inside a `$effect` or reactive statement, NOT by triggering full component re-renders.

2. **SvelteKit SPA mode** — Use `@sveltejs/adapter-static` with `fallback: 'index.html'` for SPA routing. The daemon must serve the built `dashboard/build/` directory as static files. Add a static file middleware to the Hono server: serve `/` through `/` from the dashboard build dir.

3. **Entity extraction LLM latency** — Stage 1 (entity extraction) makes an LLM call for every request. Cache extraction results for identical inputs (simple hash of input → result). TTL: 5 minutes. This prevents redundant LLM calls during testing.

4. **TraversalLedger storage** — The `TraversalLedger` for a trace must be stored durably so that deferred traces can apply credit weeks later. Add a `ledger_json TEXT` column to the `traces` table. Serialize the full ledger (array of TraversalEntry) as JSON at trace creation time.

5. **Deferred trace check_fn serialization** — `check_fn` is a JavaScript function — it cannot be stored in SQLite. Solution: store the verifier name + verifier parameters in the `traces.metadata` JSON. The background worker reconstructs the check function from the verifier registry (a `Map<string, (params) => Promise<OutcomeSignal | null>>`). Verifiers must be registered at daemon startup.

6. **noVNC port leaks** — If the daemon crashes while a browser subagent is running, the noVNC/VNC ports remain open. On daemon startup, scan for orphaned Docker containers matching the `0agent/subagent-runtime:chrome` image and kill them.

7. **D3 graph performance at scale** — Force simulations for 500+ nodes will lag. Implement: (a) limit displayed nodes to top-50 by `visit_count` by default, (b) add a zoom/filter control, (c) use `requestAnimationFrame` throttling in the tick handler.

8. **Attribution ambiguity in DAG** — Two paths contributing equally to an outcome must split credit 50/50. But "equally likely" is hard to define exactly. Implementation rule: if two DAG paths have `abs(credit_a - credit_b) < 0.01`, treat as tied and split. This prevents floating-point jitter from causing asymmetric attribution.

9. **InferenceEngine session affinity** — Each session has its own `WorkingMemory` and `TraversalLedger`. If two concurrent sessions both trigger inference on the same entities, they share the graph but have separate ledgers. Ensure `SessionManager` maintains a `Map<session_id, InferenceContext>` and passes the right context to each `infer()` call.

10. **MCPEnrichedResolver staging** — CRM enrichment (e.g., "lookup Acme Corp in Salesforce via MCP") must NOT block entity resolution if the MCP call is slow. Run enrichment asynchronously: start it, use whatever is already in the graph for the current request, and merge enrichment results into the graph for future requests. Never hold up the main inference pipeline for enrichment.

---

## Integration Points with Other Phases

- **Phase 1 (Core)**: `WeightPropagation.computeInfluence()`, `computeDiscount()`, `applyCredit()` from Phase 1 are used directly by `CreditAttribution.ts`. Do not re-implement these — import and call them.
- **Phase 2 (Daemon)**: `InferenceEngine` is injected into `SessionManager` as the `IExecutionEngine` interface stub from Phase 2. `BackgroundWorkers.resolveDeferred()` grows from its stub to the full implementation here.
- **Phase 3 (Subagents)**: `InferenceEngine` calls `SubagentOrchestrator.spawn()`. `SubagentResult.artifacts` are processed into the learning pipeline. `SubagentResult.tool_calls` feed `TraversalLedger` recording.
- **Phase 5 (Compaction)**: `ArchivalMemory` writes compressed summaries to `ObjectStore`. Phase 5's `SubgraphArchiver` also uses `ObjectStore`. They must not write to the same path prefix — use `memory/` vs `subgraph/` prefixes in `ObjectStore`.
- **Phase 5 (Accuracy)**: The 100-trace accuracy measurement here is the baseline. Phase 5's seed graphs provide starting weights that make the 100-trace threshold achievable faster.
- **Phase 2 (Skill Library)**: `SkillRegistry` provides `SkillDefinition` objects used to populate the `/skills` dashboard pages. The `/retro` skill is defined in the skill library YAML but its `learning_signal` outcome type is handled entirely in Phase 4's `DeferredTraceResolver`.
- **Phase 3 (Skill Invoker)**: `SkillInvoker` passes `skill_name` in `SpawnRequest.context` so that `InferenceEngine` can decorate the resulting trace with `metadata.skill_name`. The `WorkflowSuggestionEngine` reads the same workflow graph that `SkillInvoker`'s chaining logic uses.
- **Phase 5 (Sprint Workflow Seed)**: The sprint workflow seed graph from Phase 5 provides the initial edge weights that the `WorkflowSuggestionEngine` reads. `/retro` learning signals update these weights over time.

---

## Self-Improvement Engine (Phase 4 Addition)

The self-improvement engine is a meta-capability that the main agent (Level 0) executes directly — never delegated to a subagent. It runs:
- At the end of every `/retro`
- On a configurable schedule (default: weekly)
- On manual trigger via `0agent improve`

### Files

| File | Responsibility |
|------|---------------|
| `packages/core/src/types/SelfImprovement.ts` | Types: ImprovementPlan, SkillGap, WorkflowChange, GraphHealth, ToolUtilization, SkillRefinement, PriorityAction |
| `packages/core/src/engine/SelfImprovementPrompt.ts` | The 5-analysis system prompt (injected with graph/trace data as context) |
| `packages/core/src/engine/SelfImprovementEngine.ts` | Runs the 5 analyses, produces ImprovementPlan JSON |
| `packages/daemon/src/SelfImprovementApplicator.ts` | Reads plan + AutoApplyPolicy, applies safe actions, queues risky ones |
| `packages/daemon/src/BackgroundWorkers.ts` | Extended: schedule self-improvement runs (weekly/daily/after_retro) |

### The 5 Analyses

1. **Skill Gap Detection** — Find traces where bootstrap mode triggered or resolution confidence < 0.65. Propose: new skill YAML, seed graph additions, MCP tool, or entity observations.
2. **Workflow Optimization** — Scan sprint workflow edges: remove decayed (<0.3), recommend strengthened (>0.85), detect missing transitions, find bottleneck skills.
3. **Graph Health** — Contradiction clusters (weight ~0.5 with high traverse count), dead zones (30+ day subgraphs), duplicates (embedding sim >0.92), orphan nodes (zero edges).
4. **Tool Utilization** — High-use tools (outcome quality), unused tools (disconnect?), browser-to-API patterns (suggest MCP), auth failures.
5. **Skill Prompt Refinement** — Per-skill success rate, common failure patterns, propose specific role_prompt edits for skills below 70% success.

### Auto-Apply Policy

```yaml
self_improvement:
  enabled: true
  schedule: weekly
  auto_apply:
    graph_health: true      # auto: merge duplicates, archive dead zones, prune orphans
    workflow_edges: false    # propose only — user approves
    skill_prompts: false     # propose only — user approves
    tool_install: false      # propose only — user approves
    new_skills: false        # propose only — user approves
```

### CLI Commands

```bash
0agent improve                  # run self-improvement analysis now
0agent improve show             # view latest improvement plan
0agent improve apply 1          # apply priority action #1
0agent improve apply all-safe   # apply all auto-approvable actions
0agent improve apply all        # apply everything (requires confirmation)
0agent improve history          # past plans + what was applied
```

### Integration with /retro

When `/retro` completes (its `outcome.type` is `learning_signal`), the daemon checks `config.self_improvement.schedule`. If `after_every_retro`, it immediately runs `SelfImprovementEngine.analyze()` with the retro's evaluation period. The improvement plan is stored in `~/.0agent/improvements/` and auto-appliable actions are applied per policy.

### Acceptance Criteria

- Self-improvement engine produces valid ImprovementPlan JSON
- Graph health analysis finds contradictions, dead zones, orphans in a test graph
- `0agent improve` triggers analysis and prints priority actions
- Auto-apply respects policy: `graph_health: true` actions apply, `workflow_edges: false` actions queue
- Improvement history tracks what was applied and by whom
