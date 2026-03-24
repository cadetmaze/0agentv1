import Database, { type Database as DatabaseType, type Statement } from 'better-sqlite3';
import type { GraphNode, NodeContent, ContentType, NodeType } from '../../graph/GraphNode.js';
import type { GraphEdge, EdgeType } from '../../graph/GraphEdge.js';

// ---- Exported record types ----

export interface WeightEvent {
  id: string;
  edge_id: string;
  old_weight: number;
  new_weight: number;
  delta: number;
  reason: string;
  trace_id: string | null;
  created_at: number;
}

export interface TraceRecord {
  id: string;
  session_id: string;
  input: string;
  plan: string;
  outcome_signal: number | null;
  outcome_type: string | null;
  resolved_at: number | null;
  deferred: boolean;
  deferred_until: number | null;
  created_at: number;
  metadata: Record<string, unknown>;
}

export interface AliasRecord {
  alias: string;
  node_id: string;
  confidence: number;
  created_at: number;
}

// ---- SQLite Adapter ----

export interface SQLiteAdapterOptions {
  db_path: string;
}

export class SQLiteAdapter {
  private db: DatabaseType;

  // Prepared statements — lazily initialized
  private _stmtCache = new Map<string, Statement>();

  constructor(opts: SQLiteAdapterOptions) {
    this.db = new Database(opts.db_path === ':memory:' ? ':memory:' : opts.db_path);

    // Pragmas
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');

    // Schema
    this.db.exec(SCHEMA_SQL);
    this.db.exec(INDEX_SQL);
  }

  // ---- Helpers ----

  private stmt(sql: string): Statement {
    let s = this._stmtCache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this._stmtCache.set(sql, s);
    }
    return s;
  }

  // ---- Nodes ----

  insertNode(node: GraphNode): void {
    const txn = this.db.transaction(() => {
      this.stmt(`
        INSERT INTO nodes (id, graph_id, label, type, created_at, last_seen, visit_count, metadata, subgraph_id, embedding, embedding_model, embedding_at)
        VALUES (@id, @graph_id, @label, @type, @created_at, @last_seen, @visit_count, @metadata, @subgraph_id, @embedding, @embedding_model, @embedding_at)
      `).run({
        id: node.id,
        graph_id: node.graph_id,
        label: node.label,
        type: node.type,
        created_at: node.created_at,
        last_seen: node.last_seen,
        visit_count: node.visit_count,
        metadata: JSON.stringify(node.metadata),
        subgraph_id: node.subgraph_id,
        embedding: node.embedding ? Buffer.from(node.embedding.buffer) : null,
        embedding_model: node.embedding_model,
        embedding_at: node.embedding_at,
      });

      const insertContent = this.stmt(`
        INSERT INTO node_content (id, node_id, type, data, metadata)
        VALUES (@id, @node_id, @type, @data, @metadata)
      `);

      for (const c of node.content) {
        insertContent.run({
          id: c.id,
          node_id: node.id,
          type: c.type,
          data: c.data,
          metadata: JSON.stringify(c.metadata),
        });
      }
    });
    txn();
  }

  getNode(id: string): GraphNode | null {
    const row = this.stmt(`SELECT * FROM nodes WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!row) return null;

    const contentRows = this.stmt(`SELECT * FROM node_content WHERE node_id = ?`).all(id) as Record<string, unknown>[];

    return this.mapNode(row, contentRows);
  }

  updateNode(id: string, updates: Partial<Omit<GraphNode, 'id' | 'content'>>): void {
    const fields: string[] = [];
    const values: Record<string, unknown> = { id };

    if (updates.graph_id !== undefined) { fields.push('graph_id = @graph_id'); values.graph_id = updates.graph_id; }
    if (updates.label !== undefined) { fields.push('label = @label'); values.label = updates.label; }
    if (updates.type !== undefined) { fields.push('type = @type'); values.type = updates.type; }
    if (updates.created_at !== undefined) { fields.push('created_at = @created_at'); values.created_at = updates.created_at; }
    if (updates.last_seen !== undefined) { fields.push('last_seen = @last_seen'); values.last_seen = updates.last_seen; }
    if (updates.visit_count !== undefined) { fields.push('visit_count = @visit_count'); values.visit_count = updates.visit_count; }
    if (updates.metadata !== undefined) { fields.push('metadata = @metadata'); values.metadata = JSON.stringify(updates.metadata); }
    if (updates.subgraph_id !== undefined) { fields.push('subgraph_id = @subgraph_id'); values.subgraph_id = updates.subgraph_id; }
    if (updates.embedding !== undefined) {
      fields.push('embedding = @embedding');
      values.embedding = updates.embedding ? Buffer.from(updates.embedding.buffer) : null;
    }
    if (updates.embedding_model !== undefined) { fields.push('embedding_model = @embedding_model'); values.embedding_model = updates.embedding_model; }
    if (updates.embedding_at !== undefined) { fields.push('embedding_at = @embedding_at'); values.embedding_at = updates.embedding_at; }

    if (fields.length === 0) return;

    // Dynamic SQL — cannot be cached since fields vary
    this.db.prepare(`UPDATE nodes SET ${fields.join(', ')} WHERE id = @id`).run(values);
  }

  updateNodeLastSeen(id: string, ts: number): void {
    this.stmt(`UPDATE nodes SET last_seen = ?, visit_count = visit_count + 1 WHERE id = ?`).run(ts, id);
  }

  deleteNode(id: string): void {
    this.stmt(`DELETE FROM nodes WHERE id = ?`).run(id);
  }

  queryNodes(opts: { graph_id?: string; type?: string; subgraph_id?: string; limit?: number }): GraphNode[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts.graph_id !== undefined) { conditions.push('graph_id = ?'); params.push(opts.graph_id); }
    if (opts.type !== undefined) { conditions.push('type = ?'); params.push(opts.type); }
    if (opts.subgraph_id !== undefined) { conditions.push('subgraph_id = ?'); params.push(opts.subgraph_id); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limitClause = opts.limit !== undefined ? `LIMIT ?` : '';
    if (opts.limit !== undefined) params.push(opts.limit);

    const rows = this.db.prepare(`SELECT * FROM nodes ${where} ${limitClause}`).all(...params) as Record<string, unknown>[];

    return rows.map((row) => {
      const contentRows = this.stmt(`SELECT * FROM node_content WHERE node_id = ?`).all(row.id as string) as Record<string, unknown>[];
      return this.mapNode(row, contentRows);
    });
  }

  countNodes(graph_id?: string): number {
    if (graph_id !== undefined) {
      const row = this.stmt(`SELECT COUNT(*) as cnt FROM nodes WHERE graph_id = ?`).get(graph_id) as { cnt: number };
      return row.cnt;
    }
    const row = this.stmt(`SELECT COUNT(*) as cnt FROM nodes`).get() as { cnt: number };
    return row.cnt;
  }

  // ---- Edges ----

  insertEdge(edge: GraphEdge): void {
    this.stmt(`
      INSERT INTO edges (id, graph_id, from_node, to_node, type, weight, locked, decay_rate, created_at, last_traversed, traversal_count, metadata)
      VALUES (@id, @graph_id, @from_node, @to_node, @type, @weight, @locked, @decay_rate, @created_at, @last_traversed, @traversal_count, @metadata)
    `).run({
      id: edge.id,
      graph_id: edge.graph_id,
      from_node: edge.from_node,
      to_node: edge.to_node,
      type: edge.type,
      weight: edge.weight,
      locked: edge.locked ? 1 : 0,
      decay_rate: edge.decay_rate,
      created_at: edge.created_at,
      last_traversed: edge.last_traversed,
      traversal_count: edge.traversal_count,
      metadata: JSON.stringify(edge.metadata),
    });
  }

  getEdge(id: string): GraphEdge | null {
    const row = this.stmt(`SELECT * FROM edges WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapEdge(row);
  }

  updateEdgeWeight(id: string, newWeight: number, expectedWeight: number): boolean {
    const result = this.stmt(`UPDATE edges SET weight = ? WHERE id = ? AND weight = ?`).run(newWeight, id, expectedWeight);
    return result.changes === 1;
  }

  updateEdgeTraversal(id: string, ts: number): void {
    this.stmt(`UPDATE edges SET last_traversed = ?, traversal_count = traversal_count + 1 WHERE id = ?`).run(ts, id);
  }

  deleteEdge(id: string): void {
    this.stmt(`DELETE FROM edges WHERE id = ?`).run(id);
  }

  getEdgesByNode(nodeId: string, direction: 'from' | 'to' | 'both'): GraphEdge[] {
    let rows: Record<string, unknown>[];
    if (direction === 'from') {
      rows = this.stmt(`SELECT * FROM edges WHERE from_node = ?`).all(nodeId) as Record<string, unknown>[];
    } else if (direction === 'to') {
      rows = this.stmt(`SELECT * FROM edges WHERE to_node = ?`).all(nodeId) as Record<string, unknown>[];
    } else {
      rows = this.stmt(`SELECT * FROM edges WHERE from_node = ? OR to_node = ?`).all(nodeId, nodeId) as Record<string, unknown>[];
    }
    return rows.map((r) => this.mapEdge(r));
  }

  getEdgesBetween(fromId: string, toId: string): GraphEdge[] {
    const rows = this.stmt(`SELECT * FROM edges WHERE from_node = ? AND to_node = ?`).all(fromId, toId) as Record<string, unknown>[];
    return rows.map((r) => this.mapEdge(r));
  }

  getAllEdges(graph_id?: string): GraphEdge[] {
    let rows: Record<string, unknown>[];
    if (graph_id !== undefined) {
      rows = this.stmt(`SELECT * FROM edges WHERE graph_id = ?`).all(graph_id) as Record<string, unknown>[];
    } else {
      rows = this.stmt(`SELECT * FROM edges`).all() as Record<string, unknown>[];
    }
    return rows.map((r) => this.mapEdge(r));
  }

  // ---- Weight Events ----

  insertWeightEvent(event: WeightEvent): void {
    this.stmt(`
      INSERT INTO weight_events (id, edge_id, old_weight, new_weight, delta, reason, trace_id, created_at)
      VALUES (@id, @edge_id, @old_weight, @new_weight, @delta, @reason, @trace_id, @created_at)
    `).run({
      id: event.id,
      edge_id: event.edge_id,
      old_weight: event.old_weight,
      new_weight: event.new_weight,
      delta: event.delta,
      reason: event.reason,
      trace_id: event.trace_id,
      created_at: event.created_at,
    });
  }

  getWeightEvents(edgeId: string): WeightEvent[] {
    const rows = this.stmt(`SELECT * FROM weight_events WHERE edge_id = ? ORDER BY created_at`).all(edgeId) as Record<string, unknown>[];
    return rows.map((r) => this.mapWeightEvent(r));
  }

  getWeightEventsByTrace(traceId: string): WeightEvent[] {
    const rows = this.stmt(`SELECT * FROM weight_events WHERE trace_id = ? ORDER BY created_at`).all(traceId) as Record<string, unknown>[];
    return rows.map((r) => this.mapWeightEvent(r));
  }

  // ---- Traces ----

  insertTrace(trace: TraceRecord): void {
    this.stmt(`
      INSERT INTO traces (id, session_id, input, plan, outcome_signal, outcome_type, resolved_at, deferred, deferred_until, created_at, metadata)
      VALUES (@id, @session_id, @input, @plan, @outcome_signal, @outcome_type, @resolved_at, @deferred, @deferred_until, @created_at, @metadata)
    `).run({
      id: trace.id,
      session_id: trace.session_id,
      input: trace.input,
      plan: trace.plan,
      outcome_signal: trace.outcome_signal,
      outcome_type: trace.outcome_type,
      resolved_at: trace.resolved_at,
      deferred: trace.deferred ? 1 : 0,
      deferred_until: trace.deferred_until,
      created_at: trace.created_at,
      metadata: JSON.stringify(trace.metadata),
    });
  }

  getTrace(id: string): TraceRecord | null {
    const row = this.stmt(`SELECT * FROM traces WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapTrace(row);
  }

  updateTraceOutcome(id: string, signal: number, type: string, resolvedAt: number): void {
    this.stmt(`UPDATE traces SET outcome_signal = ?, outcome_type = ?, resolved_at = ? WHERE id = ?`).run(signal, type, resolvedAt, id);
  }

  queryTraces(opts: { session_id?: string; deferred?: boolean; limit?: number }): TraceRecord[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts.session_id !== undefined) { conditions.push('session_id = ?'); params.push(opts.session_id); }
    if (opts.deferred !== undefined) { conditions.push('deferred = ?'); params.push(opts.deferred ? 1 : 0); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limitClause = opts.limit !== undefined ? `LIMIT ?` : '';
    if (opts.limit !== undefined) params.push(opts.limit);

    const rows = this.db.prepare(`SELECT * FROM traces ${where} ORDER BY created_at DESC ${limitClause}`).all(...params) as Record<string, unknown>[];
    return rows.map((r) => this.mapTrace(r));
  }

  // ---- Aliases ----

  insertAlias(alias: string, nodeId: string, confidence: number): void {
    this.stmt(`
      INSERT OR REPLACE INTO aliases (alias, node_id, confidence, created_at)
      VALUES (?, ?, ?, ?)
    `).run(alias, nodeId, confidence, Date.now());
  }

  getAliases(nodeId: string): AliasRecord[] {
    const rows = this.stmt(`SELECT * FROM aliases WHERE node_id = ?`).all(nodeId) as Record<string, unknown>[];
    return rows.map((r) => this.mapAlias(r));
  }

  findByAlias(alias: string): AliasRecord[] {
    const rows = this.stmt(`SELECT * FROM aliases WHERE alias = ?`).all(alias) as Record<string, unknown>[];
    return rows.map((r) => this.mapAlias(r));
  }

  deleteAlias(alias: string, nodeId: string): void {
    this.stmt(`DELETE FROM aliases WHERE alias = ? AND node_id = ?`).run(alias, nodeId);
  }

  // ---- Force update (LWW fallback for OCC) ----

  forceUpdateEdgeWeight(id: string, newWeight: number): void {
    this.stmt(`UPDATE edges SET weight = ? WHERE id = ?`).run(newWeight, id);
  }

  // ---- Node Content (direct) ----

  insertNodeContent(content: NodeContent): void {
    this.stmt(`
      INSERT INTO node_content (id, node_id, type, data, metadata)
      VALUES (@id, @node_id, @type, @data, @metadata)
    `).run({
      id: content.id,
      node_id: content.node_id,
      type: content.type,
      data: content.data,
      metadata: JSON.stringify(content.metadata),
    });
  }

  getNodeContent(nodeId: string): NodeContent[] {
    const rows = this.stmt(`SELECT * FROM node_content WHERE node_id = ?`).all(nodeId) as Record<string, unknown>[];
    return rows.map((c) => ({
      id: c.id as string,
      node_id: c.node_id as string,
      type: c.type as string as ContentType,
      data: c.data as string,
      metadata: JSON.parse(c.metadata as string),
    }));
  }

  // ---- Edge Count ----

  countEdges(graph_id?: string): number {
    if (graph_id !== undefined) {
      const row = this.stmt(`SELECT COUNT(*) as cnt FROM edges WHERE graph_id = ?`).get(graph_id) as { cnt: number };
      return row.cnt;
    }
    const row = this.stmt(`SELECT COUNT(*) as cnt FROM edges`).get() as { cnt: number };
    return row.cnt;
  }

  // ---- Lifecycle ----

  close(): void {
    this.db.close();
  }

  // ---- Row mappers ----

  private mapNode(row: Record<string, unknown>, contentRows: Record<string, unknown>[]): GraphNode {
    let embedding: Float32Array | null = null;
    if (row.embedding && row.embedding instanceof Buffer) {
      embedding = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
    }

    return {
      id: row.id as string,
      graph_id: row.graph_id as string,
      label: row.label as string,
      type: row.type as string as NodeType,
      created_at: row.created_at as number,
      last_seen: row.last_seen as number,
      visit_count: row.visit_count as number,
      metadata: JSON.parse(row.metadata as string),
      subgraph_id: (row.subgraph_id as string) ?? null,
      embedding,
      embedding_model: (row.embedding_model as string) ?? null,
      embedding_at: (row.embedding_at as number) ?? null,
      content: contentRows.map((c) => ({
        id: c.id as string,
        node_id: c.node_id as string,
        type: c.type as string as ContentType,
        data: c.data as string,
        metadata: JSON.parse(c.metadata as string),
      })),
    };
  }

  private mapEdge(row: Record<string, unknown>): GraphEdge {
    return {
      id: row.id as string,
      graph_id: row.graph_id as string,
      from_node: row.from_node as string,
      to_node: row.to_node as string,
      type: row.type as string as EdgeType,
      weight: row.weight as number,
      locked: (row.locked as number) === 1,
      decay_rate: row.decay_rate as number,
      created_at: row.created_at as number,
      last_traversed: (row.last_traversed as number) ?? null,
      traversal_count: row.traversal_count as number,
      metadata: JSON.parse(row.metadata as string),
    };
  }

  private mapWeightEvent(row: Record<string, unknown>): WeightEvent {
    return {
      id: row.id as string,
      edge_id: row.edge_id as string,
      old_weight: row.old_weight as number,
      new_weight: row.new_weight as number,
      delta: row.delta as number,
      reason: row.reason as string,
      trace_id: (row.trace_id as string) ?? null,
      created_at: row.created_at as number,
    };
  }

  private mapTrace(row: Record<string, unknown>): TraceRecord {
    return {
      id: row.id as string,
      session_id: row.session_id as string,
      input: row.input as string,
      plan: row.plan as string,
      outcome_signal: (row.outcome_signal as number) ?? null,
      outcome_type: (row.outcome_type as string) ?? null,
      resolved_at: (row.resolved_at as number) ?? null,
      deferred: (row.deferred as number) === 1,
      deferred_until: (row.deferred_until as number) ?? null,
      created_at: row.created_at as number,
      metadata: JSON.parse(row.metadata as string),
    };
  }

  private mapAlias(row: Record<string, unknown>): AliasRecord {
    return {
      alias: row.alias as string,
      node_id: row.node_id as string,
      confidence: row.confidence as number,
      created_at: row.created_at as number,
    };
  }
}

// ---- Schema SQL ----

const SCHEMA_SQL = `
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
`;

const INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_nodes_graph_type ON nodes(graph_id, type);
CREATE INDEX IF NOT EXISTS idx_nodes_subgraph ON nodes(subgraph_id);
CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_node);
CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_node);
CREATE INDEX IF NOT EXISTS idx_edges_graph ON edges(graph_id);
CREATE INDEX IF NOT EXISTS idx_weight_events_edge ON weight_events(edge_id);
CREATE INDEX IF NOT EXISTS idx_weight_events_trace ON weight_events(trace_id);
CREATE INDEX IF NOT EXISTS idx_aliases_alias ON aliases(alias);
CREATE INDEX IF NOT EXISTS idx_traces_session ON traces(session_id);
`;
