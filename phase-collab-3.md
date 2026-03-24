# Phase Collab-3: "We Know Together" — Team Graphs + Sync Server + Invites

## Goal

Invite a teammate. Your agents share a knowledge graph. The team learns together — strategy nodes, skill weights, and attenuated activity signals propagate across machines without any external account required. This phase introduces a self-hostable sync server, an invite code model, a team graph overlay that layers on top of each member's personal graph, and a team dashboard page. The privacy model is strict and built at the data layer: personal graph data never leaves the device.

This phase builds on Phase Collab-1 (UserIdentity, IdentityManager), the existing KnowledgeGraph + EdgeType system (Phase 1), the OCC session snapshot isolation (Phase 5), and the EntityHierarchy visibility policy (Phase 3).

---

## Complete File List

### New package — packages/sync-server/

| File | Responsibility |
|------|----------------|
| `package.json` | `@0agent/sync-server`. Dependencies: `hono`, `@hono/node-server`, `better-sqlite3`, `nanoid`. Exports a `startSyncServer()` function. |
| `tsconfig.json` | Extends `../../tsconfig.base.json`. |
| `src/index.ts` | Entry point. Calls `createApp()`, starts Hono server on `PORT` env var (default 4201). Handles SIGTERM gracefully. |
| `src/createApp.ts` | Mounts all route modules onto a Hono app. Returns the app. Separates construction from listening so it can be tested without binding a port. |
| `src/routes/teams.ts` | `POST /teams` (create team + generate invite code), `GET /teams/:code` (join info — returns team name + member count, not member details), `DELETE /teams/:id` (creator only). |
| `src/routes/sync.ts` | `POST /teams/:id/push` (push `SyncDelta` from member), `GET /teams/:id/pull?since=<timestamp>` (get all deltas since timestamp, excluding pusher's own). |
| `src/routes/members.ts` | `GET /teams/:id/members` (member list — name + device_id + last_synced_at), `POST /teams/:id/members` (join — provide entity_id + name + device_id), `DELETE /teams/:id/members/:entity_id`. |
| `src/SyncStore.ts` | SQLite-backed storage. Schema: `teams`, `team_members`, `sync_deltas` tables. Methods: `createTeam()`, `getTeamByCode()`, `pushDelta()`, `pullDeltas(teamId, since, excludeEntityId)`, `addMember()`, `removeMember()`. |
| `src/InviteCode.ts` | Generate 8-character memorable codes in format "ABC-1234" (3 alpha + dash + 4 alphanum). Validate format. Check uniqueness against `SyncStore`. Optional expiry (`invite_expires_at`). |
| `src/auth.ts` | Minimal auth: each request carries `entity_id` + `team_id` in headers or body. `SyncStore` verifies membership before any read/write. No JWT — this is LAN-first, not internet-first. |

### New files — packages/daemon/src/

| File | Responsibility |
|------|----------------|
| `src/TeamManager.ts` | Manages team memberships stored in `~/.0agent/teams.json`. Loads team graph overlays on daemon startup. Registers the user entity in a team graph on join. Provides `getTeamsForUser()`, `joinTeam()`, `leaveTeam()`. |
| `src/TeamSync.ts` | Background worker. Runs every 30 seconds. For each team the user is in: push local `WeightEvent[]` since last sync → `POST /teams/:id/push`. Pull deltas since last sync → `GET /teams/:id/pull`. Apply pulled deltas via `graph.applyTeamDelta()`. Emits `team.synced` WS event. |

### Modified files

| File | Change |
|------|--------|
| `packages/core/src/graph/KnowledgeGraph.ts` | Add `withOverlay(teamGraph: KnowledgeGraph): OverlayGraph` factory. Add `applyTeamDelta(delta: SyncDelta): void` method. |
| `packages/core/src/graph/KnowledgeGraph.ts` | New inner class `OverlayGraph` (or separate file `OverlayGraph.ts`): reads from personal first, falls through to team graph. Writes always go to personal. |
| `packages/daemon/src/ZeroAgentDaemon.ts` | After startup step 2: initialize `TeamManager`, load team graphs, start `TeamSync` worker via `BackgroundWorkers`. |
| `packages/daemon/src/BackgroundWorkers.ts` | Register `TeamSync` as a new worker with a 30-second interval. |
| `packages/daemon/src/WebSocketEvents.ts` | Add `team.synced`, `team.member_joined`, `team.member_left` event types to `DaemonEvent` union. |
| `packages/daemon/src/HTTPServer.ts` | Mount `teamRoutes` at `/api/teams`. |
| `packages/daemon/src/routes/` | New file `teams.ts` (daemon-side): `GET /api/teams` (list user's teams), `POST /api/teams/join`, `DELETE /api/teams/:id`. Proxies to sync server internally. |
| `bin/0agent.js` | Add `team` command dispatch. Handle `0agent team create`, `0agent team join`, `0agent team list`, `0agent team leave`, `0agent serve`. |
| `packages/dashboard/src/routes/` | New SvelteKit page `+page.svelte` at `/team` route. Shows member list, last sync times, shared skill weights table, delta activity feed. |

### New config file

| File | Responsibility |
|------|----------------|
| `~/.0agent/teams.json` | Persistent list of teams the user has joined. Written by `TeamManager`. Never contains personal graph data. Schema defined below. |

---

## Key Interfaces and Types

```typescript
// packages/sync-server/src/SyncStore.ts + packages/daemon/src/TeamManager.ts

export interface Team {
  id: string;              // "team_abc123" — generated by sync server
  name: string;            // "Acme Engineering"
  invite_code: string;     // "ACM-7X2K" — 8 chars, memorable
  invite_expires_at?: number; // optional: Unix ms. Null = never expires.
  members: TeamMember[];
  shared_graph_id: string; // the team's KnowledgeGraph ID — all team nodes use this graph_id
  sync_server_url: string; // "https://sync.0agent.dev" (future) or "http://192.168.1.10:4201"
  created_by_entity_id: string;
  created_at: number;
}

export interface TeamMember {
  entity_node_id: string;  // their user entity ID (usr_abc123)
  name: string;            // "Marcus Lee"
  device_id: string;       // "macOS-Marcus-MBP"
  joined_at: number;
  last_synced_at: number;
}

// Written to ~/.0agent/teams.json
export interface LocalTeamRecord {
  team_id: string;
  team_name: string;
  invite_code: string;
  sync_server_url: string;
  shared_graph_id: string;
  joined_at: number;
  last_synced_at: number;
  local_graph_db_path: string; // e.g. ~/.0agent/teams/team_abc123.db
}
```

```typescript
// packages/core/src/graph/KnowledgeGraph.ts (additions)
// packages/daemon/src/TeamSync.ts

export interface SyncDelta {
  team_id: string;
  member_entity_id: string;   // who is pushing this delta
  member_name: string;        // for display in dashboard
  events: WeightEvent[];      // edge weight changes only — no node content
  signal_nodes: SignalNode[]; // attenuated signals: type + summary, no raw content
  timestamp: number;          // Unix ms — when this delta was created
  delta_id: string;           // nanoid — idempotency key
}

// WeightEvent = edge_id + new_weight + timestamp. Already exists in WeightEventLog.ts (Phase 1).
// Must verify WeightEventLog.ts exports this type; if not, define it here.

export interface SignalNode {
  id: string;
  type: string;              // e.g. "build_run", "test_failure", "skill_used"
  summary: string;           // one-line, no personal content: "ran /build 3 times"
  weight: number;            // signal strength: 0.0-1.0
  created_at: number;
  // Explicitly NO: raw conversation text, personal entity data, personality profiles
}
```

```typescript
// packages/core/src/graph/OverlayGraph.ts

export class OverlayGraph {
  constructor(
    private personal: KnowledgeGraph,
    private team: KnowledgeGraph,
  ) {}

  // Read: personal first, fall through to team
  getNode(id: string): GraphNode | null {
    return this.personal.getNode(id) ?? this.team.getNode(id);
  }

  // Write: always personal
  addNode(node: GraphNode): void {
    this.personal.addNode(node);
  }

  // Query: merge results from both, deduplicate by id, personal wins on conflict
  queryNodes(query: GraphQuery): QueryResult {
    const personalResult = this.personal.queryNodes(query);
    const teamResult = this.team.queryNodes(query);
    const seen = new Set(personalResult.nodes.map(n => n.id));
    const merged = [...personalResult.nodes, ...teamResult.nodes.filter(n => !seen.has(n.id))];
    return { nodes: merged, edges: [...personalResult.edges, ...teamResult.edges] };
  }

  // Team delta application: write weight events to team graph only
  applyTeamDelta(delta: SyncDelta): void {
    for (const event of delta.events) {
      const edge = this.team.getEdge(event.edge_id);
      if (edge) {
        // Apply weight event using existing OCC logic — team graph is the target
        this.team.setEdgeWeight(event.edge_id, event.new_weight);
      }
      // Unknown edge_id from another member's graph — create a stub edge if possible
      // or skip silently. Log unknown edges for debugging.
    }
    for (const signal of delta.signal_nodes) {
      this.team.addNode(createNode({
        id: signal.id,
        graph_id: this.team.graphId,
        label: signal.summary,
        type: NodeType.SIGNAL,
        metadata: { from_entity: delta.member_entity_id, signal_type: signal.type, weight: signal.weight },
      }));
    }
  }
}
```

```typescript
// packages/daemon/src/WebSocketEvents.ts — new team events

| { type: 'team.synced';       team_id: string; pushed: number; pulled: number; member_count: number }
| { type: 'team.member_joined'; team_id: string; member_name: string; device_id: string }
| { type: 'team.member_left';  team_id: string; member_entity_id: string }
```

---

## Implementation Order

### Step 1 — packages/sync-server: SyncStore + InviteCode (no HTTP yet)
Build the SQLite schema for `teams`, `team_members`, `sync_deltas`. Implement `createTeam()`, `getTeamByCode()`, `addMember()`, `pushDelta()`, `pullDeltas()`. Write unit tests. Build `InviteCode.generate()` and `InviteCode.validate()` separately — pure functions, no DB dependency.

### Step 2 — packages/sync-server: HTTP routes + createApp
Mount routes. Test with `fetch()` calls in integration tests — no real network. Use `hono/testing` or direct `app.fetch()` for request simulation. All routes verified against schema.

### Step 3 — OverlayGraph (packages/core)
Add `OverlayGraph.ts` to `packages/core/src/graph/`. Implement `getNode`, `addNode`, `queryNodes`, `applyTeamDelta`. Export from `packages/core/index.ts`. Write unit tests: verify that personal node takes priority over team node with same ID; verify `addNode` writes to personal only; verify `applyTeamDelta` applies weight events to team graph without touching personal graph.

### Step 4 — TeamManager (packages/daemon)
Build `TeamManager` with `~/.0agent/teams.json` persistence. Implement `joinTeam(inviteCode, syncServerUrl)`: call `POST /teams/:id/members` on the sync server, download current team delta via `GET /teams/:id/pull?since=0`, create a local SQLite DB for the team graph at `~/.0agent/teams/team_<id>.db`, write `LocalTeamRecord` to `teams.json`.

### Step 5 — TeamSync background worker (packages/daemon)
Build `TeamSync.sync()` method. On each tick: for each `LocalTeamRecord` in `~/.0agent/teams.json`: (a) collect `WeightEvent[]` since `last_synced_at` from `WeightEventLog`; (b) collect recent `SIGNAL` nodes created since `last_synced_at`; (c) apply privacy filter (see Privacy Model below); (d) push to sync server; (e) pull deltas from other members; (f) call `overlayGraph.applyTeamDelta()` for each; (g) update `last_synced_at`. Register in `BackgroundWorkers` with 30-second interval.

### Step 6 — ZeroAgentDaemon wiring
Add `TeamManager` and `TeamSync` initialization to `ZeroAgentDaemon.start()`. After KnowledgeGraph is initialized: create `TeamManager`, call `teamManager.loadTeamGraphs()` which opens each team's `.db` file and creates an `OverlayGraph`. Pass the `OverlayGraph` (not raw `KnowledgeGraph`) to `SessionManager` if teams are configured, otherwise pass `KnowledgeGraph` directly. This ensures zero overhead when no teams are joined.

### Step 7 — bin/0agent.js team commands
Add `team` case to command dispatch. Implement: `0agent team create <name>`, `0agent team join <code> [--server <url>]`, `0agent team list`, `0agent team leave <name>`, `0agent serve`.

### Step 8 — Dashboard /team page
SvelteKit page that calls `GET /api/teams` (daemon-side route) and `GET /api/teams/:id/members`. Renders: member list with last sync badge, shared skill weight table (top 10 edges by traversal_count from team graph), delta activity feed (last 20 signal nodes from team graph).

---

## Critical Algorithms

### Invite Code Generation

```typescript
// packages/sync-server/src/InviteCode.ts

const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I, O to avoid 1/0 confusion
const ALNUM = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generate(): string {
  const prefix = Array.from({ length: 3 }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join('');
  const suffix = Array.from({ length: 4 }, () => ALNUM[Math.floor(Math.random() * ALNUM.length)]).join('');
  return `${prefix}-${suffix}`; // e.g. "ACM-7X2K"
}

export function validate(code: string): boolean {
  return /^[A-Z]{3}-[A-Z0-9]{4}$/.test(code);
}
```

### Privacy Filter (TeamSync — what gets synced)

Applied in `TeamSync.buildDelta()` before pushing. Uses `DEFAULT_VISIBILITY_POLICY` from `EntityHierarchy.ts` (Phase 3) directly:

```typescript
function buildDelta(
  entityId: string,
  weightEvents: WeightEvent[],
  signalNodes: GraphNode[],
  graph: KnowledgeGraph,
): SyncDelta {
  // WHAT SYNCS: edge weight events for strategy/plan/context/tool edges ONLY
  const syncableEvents = weightEvents.filter(event => {
    const edge = graph.getEdge(event.edge_id);
    if (!edge) return false;
    const fromNode = graph.getNode(edge.from_node);
    const toNode = graph.getNode(edge.to_node);
    // Exclude edges where either endpoint is an ENTITY node (personal data)
    if (fromNode?.type === NodeType.ENTITY || toNode?.type === NodeType.ENTITY) return false;
    // Exclude edges connected to personality profile nodes
    if (fromNode?.label === '__personality_profile__' || toNode?.label === '__personality_profile__') return false;
    // Include: strategy, plan, context, tool, skill edges
    return ['strategy', 'plan', 'context', 'tool', 'step'].includes(fromNode?.type ?? '');
  });

  // WHAT SYNCS: SIGNAL nodes, attenuated — summary text only, no raw content
  const syncableSignals: SignalNode[] = signalNodes
    .filter(n => n.type === NodeType.SIGNAL)
    .filter(n => !n.metadata?.personal) // exclude signals marked personal
    .map(n => ({
      id: n.id,
      type: String(n.metadata?.signal_type ?? 'unknown'),
      summary: n.label,  // only the label (one-line summary) — not node content
      weight: Number(n.metadata?.weight ?? 0.5),
      created_at: n.created_at,
    }));

  // WHAT NEVER SYNCS: raw conversation turns, personality profiles,
  //                   entity nodes, hypothesis nodes, personal signal nodes.
  // These are enforced by the filters above — they are excluded at the source,
  // not stripped at the server. The sync server has no way to reconstruct them.

  return {
    team_id: teamId,
    member_entity_id: entityId,
    member_name: identity.name,
    events: syncableEvents,
    signal_nodes: syncableSignals,
    timestamp: Date.now(),
    delta_id: nanoid(),
  };
}
```

### Delta Pull + OCC Conflict Resolution

When pulling a delta from another member, `TeamSync` calls `overlayGraph.applyTeamDelta(delta)`. For each `WeightEvent` in the delta:

1. Get the edge from the team graph. If not found in team graph, check personal graph. If not found anywhere, skip (the edge belongs to an uninitiated part of the seed graph on this machine — it will appear after the next `0agent init` with the team seed).
2. If found: compare `event.timestamp` with `edge.last_traversed`. If the remote event is older than the last local traversal, apply a weighted average: `new_weight = 0.6 * local_weight + 0.4 * remote_weight`. This is the "team influence" blend.
3. If the remote event is newer: apply directly.
4. Conflicts (two members updating the same edge in the same sync window): use higher-traversal-count member's weight as tiebreaker. Log the conflict.

### `0agent serve` Self-Hosting

```bash
# packages/sync-server/src/index.ts
# Invoked by: 0agent serve

const PORT = parseInt(process.env['SYNC_PORT'] ?? '4201');
const app = createApp({ db_path: resolve(homedir(), '.0agent', 'sync.db') });
serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`0agent sync server running on http://0.0.0.0:${info.port}`);
  console.log(`Others can join with: 0agent team join <CODE> --server http://<your-ip>:${info.port}`);
});
```

The sync server is entirely standalone — it does not import `@0agent/core` or any daemon code. It only has `hono`, `better-sqlite3`, and `nanoid` as runtime dependencies. This keeps it deployable to any machine without the full 0agent stack.

---

## Sync Protocol (Delta Format on Wire)

The sync server stores and forwards deltas as-is (JSON blobs in the `sync_deltas` table). It does not merge or interpret them — it is a dumb relay with membership enforcement.

```
POST /teams/:id/push
Authorization: entity_id in header X-Entity-Id (validated as team member)
Content-Type: application/json
Body: SyncDelta JSON

Response 200: { accepted: true, delta_id: "..." }
Response 403: { error: "not a member" }
Response 422: { error: "delta too large", max_bytes: 524288 }

GET /teams/:id/pull?since=<timestamp>
Authorization: entity_id in header X-Entity-Id
Response 200: { deltas: SyncDelta[], count: number }
// Only returns deltas from OTHER members (not the requester's own pushes)
// Deltas older than 7 days are not returned (TTL enforced in SyncStore)
```

**Delta size limit**: 512KB per push. If `WeightEvent[]` is large (very active member), split into chunks across multiple pushes. `TeamSync` handles chunking automatically.

---

## External Dependencies Needed

### packages/sync-server (new package)

| Package | Version | Reason |
|---------|---------|--------|
| `hono` | `^4.x` | HTTP framework — already in daemon, use same version |
| `@hono/node-server` | `^1.x` | Node.js adapter for Hono |
| `better-sqlite3` | same as core | Team sync delta storage |
| `nanoid` | `^5.x` | delta_id and team_id generation |

### packages/daemon (additions)

| Package | Version | Reason |
|---------|---------|--------|
| `node:fetch` | built-in | HTTP calls from `TeamSync` to sync server |

No new npm packages required in `packages/daemon` — all sync-server communication is via fetch to the HTTP API.

---

## Acceptance Criteria

1. **`0agent team create "Acme Engineering"` outputs invite code**: Running the command prints `Team created: Acme Engineering` and `Invite code: ACM-7X2K`. The code is 8 characters in `XXX-XXXX` format.

2. **Second machine joins via invite code**: On machine 2, `0agent team join ACM-7X2K --server http://192.168.1.10:4201` downloads the team's current graph state, creates `~/.0agent/teams/team_<id>.db`, and writes to `~/.0agent/teams.json`. `0agent team list` shows the team with member count 2.

3. **Skill weight propagates within 60 seconds**: Run `/build` on machine 1. Within 60 seconds (two `TeamSync` ticks), machine 2's `OverlayGraph.getEdge("build→verify")` returns a weight closer to machine 1's value (the team blend has applied).

4. **`0agent serve` starts sync server**: Running `0agent serve` on machine 1 starts the sync server on port 4201, prints the LAN invite instructions. `curl http://127.0.0.1:4201/teams` returns `[]` (empty team list).

5. **Personal graph never appears in sync data**: After 5 sync cycles, query `SyncStore.pullDeltas(teamId, 0, "none")` (all deltas). Verify no delta contains: a node with `type === 'entity'`, a node with `label === '__personality_profile__'`, or any `ConversationTurn` content. This is the privacy audit.

6. **Dashboard `/team` shows member list**: Loading `localhost:4200/team` displays the team name, member list with names and last-sync timestamps, and a skill weight table showing at least 5 shared edges with their weights.

7. **`0agent team leave <name>` cleans up**: After leaving, `~/.0agent/teams.json` no longer contains the team. `~/.0agent/teams/team_<id>.db` is deleted. `ZeroAgentDaemon` no longer uses the overlay graph (falls back to personal graph only). Subsequent syncs are not attempted for this team.

8. **Team skill weights diverge from seed after 5 sprints**: After 5 `/sprint` skill runs on machine 1 and 5 `/sprint` runs on machine 2 (with different outcomes), the team graph's `sprint→review` edge weight differs from the seed graph's initial 0.5 by more than 0.05 on both machines (measurable via graph API).

---

## Integration with Existing Phases

- **Phase 1 (KnowledgeGraph + GraphEdge)**: `OverlayGraph` wraps two `KnowledgeGraph` instances. `applyTeamDelta()` uses `graph.setEdgeWeight()` — this method must exist or be added as a thin wrapper around `EdgeWeightUpdater` (Phase 1). Check `KnowledgeGraph.ts` for an existing `setEdgeWeight` method before adding one.

- **Phase 3 (EntityHierarchy + DEFAULT_VISIBILITY_POLICY)**: The privacy filter in `TeamSync.buildDelta()` uses `DEFAULT_VISIBILITY_POLICY` directly: `allow_work_context: true`, `allow_signal_nodes: true`, `allow_personality_profile: false`, `allow_raw_conversations: false`. This policy was designed for exactly this use case.

- **Phase 4 (WeightEventLog)**: `TeamSync` reads from `WeightEventLog` to get `WeightEvent[]` since `last_synced_at`. The `WeightEventLog.getByEdgeSince(timestamp)` or equivalent must exist. If only `getByEdge(edgeId)` exists, a `getEventsSince(timestamp)` method must be added to `WeightEventLog.ts`.

- **Phase 5 (SessionSnapshot + OCC)**: The team graph is a separate SQLite file per team. OCC session snapshots (Phase 5) operate on the personal `graph.db` only — the team graph does not participate in OCC. Team weight updates via `applyTeamDelta()` are applied outside session boundaries, between sessions. This avoids OCC conflicts between local session writes and remote team syncs.

- **Phase 5 (CompactionOrchestrator)**: The `CompactionOrchestrator` runs only on the personal graph. Team graphs are compacted independently by the sync server's `SyncStore.cleanup()` which deletes deltas older than 7 days. There is no compaction of the team graph SQLite files on member machines — this is acceptable for the initial implementation.

- **Phase Collab-1 (IdentityManager)**: `TeamSync` reads `identity.entity_node_id` from `IdentityManager` to set `member_entity_id` in each `SyncDelta`. The `UserIdentity.id` (not `entity_node_id`) is used as the member identifier on the sync server for privacy — it's a random ID that doesn't reveal graph structure.

---

## Risks and Gotchas

**Risk: Invite codes collide.** Mitigation: `SyncStore.createTeam()` checks uniqueness with a `SELECT` before inserting. If collision (extremely unlikely with 8 chars from 28-char alphabet): regenerate. Maximum 5 attempts before returning a 500 error. Expected collision probability with 1000 teams: < 0.01%.

**Risk: `OverlayGraph` performance — every `getNode` hits two SQLite databases.** Mitigation: Add a small LRU cache (100 entries) in `OverlayGraph.getNode()`. Personal graph nodes are cached separately from team nodes. Cache is invalidated on `addNode()` and `applyTeamDelta()`. If no teams are joined, `ZeroAgentDaemon` passes the raw `KnowledgeGraph` directly (no overlay) — zero overhead.

**Risk: Unknown edge_id in remote delta (team member has edges this machine doesn't).** Mitigation: In `applyTeamDelta()`, unknown edge IDs are logged to a `~/.0agent/logs/sync-unknown-edges.log` file and skipped. They accumulate in a `pending_edges` buffer. On the next `0agent init` with the team seed, the seed graph creates these edges and the buffer is replayed. This handles clock skew in graph initialization.

**Risk: Sync server is unreachable (offline, LAN changed).** Mitigation: `TeamSync.sync()` wraps every HTTP call in a try/catch. On network failure: log the error, skip this tick, increment `consecutive_failures` counter. After 10 consecutive failures: emit a `team.sync_degraded` WS event and pause sync for 5 minutes. The personal graph continues working normally — team sync is always best-effort.

**Risk: Delta replay is non-idempotent (same delta applied twice).** Mitigation: `SyncStore` stores `delta_id` for each delta. `TeamSync` tracks the last `delta_id` applied per team in `teams.json`. When pulling: filter out any delta whose `delta_id` is already in the applied set. `applyTeamDelta()` is safe to call twice because edge weight updates are idempotent if the weight doesn't change (and the second application would see the already-updated weight).

**Risk: Self-hosted sync server data exposed on LAN without authentication.** Mitigation: Document clearly that `0agent serve` is LAN-only and not suitable for public internet exposure without a reverse proxy with TLS. The minimal auth (entity_id header + team membership check) is sufficient for trusted LAN use but is not cryptographic. For a hardened deployment, recommend putting `nginx` + TLS in front. Mark this as `TODO: add HMAC signing to SyncDelta` in `src/auth.ts`.

**Risk: Team graph diverges irrecoverably (conflicting strategy node evolution).** Mitigation: Strategy and plan nodes are created, not mutated, in the current graph model. Edge weights between them evolve, but the nodes themselves are append-only. This means the team graph can only grow, not have contradictory node content. The only divergence risk is in edge weights — handled by the weighted-average blend in the pull algorithm.

---

## Hosted Sync Option (Planned — Not Built in This Phase)

Document in `packages/sync-server/README.md` that a hosted sync option at `sync.0agent.dev` is planned for a future phase. When available, the default behavior of `0agent team join <code>` (without `--server`) will use the hosted endpoint. The protocol is identical — the same `SyncDelta` format and REST API. Self-hosted sync servers will remain fully supported and interoperable.

```bash
# Future default (not yet built):
0agent team join ACM-7X2K          # uses sync.0agent.dev

# Self-hosted (built in this phase):
0agent team join ACM-7X2K --server http://192.168.1.10:4201
```
