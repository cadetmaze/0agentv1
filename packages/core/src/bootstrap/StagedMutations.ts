import type { GraphNode } from '../graph/GraphNode.js';
import type { GraphEdge } from '../graph/GraphEdge.js';

export interface StagedMutation {
  id: string;
  trace_id: string;
  proposed_nodes: GraphNode[];
  proposed_edges: GraphEdge[];
  created_at: number;
  expires_at: number; // created_at + 14 days
  committed: boolean;
  discarded: boolean;
}

const TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

export class StagedMutationStore {
  private mutations: Map<string, StagedMutation> = new Map();

  /**
   * Stage a new mutation (not committed to live graph).
   */
  stage(params: {
    id: string;
    trace_id: string;
    proposed_nodes: GraphNode[];
    proposed_edges: GraphEdge[];
  }): StagedMutation {
    const now = Date.now();
    const mutation: StagedMutation = {
      ...params,
      created_at: now,
      expires_at: now + TTL_MS,
      committed: false,
      discarded: false,
    };
    this.mutations.set(mutation.id, mutation);
    return mutation;
  }

  /**
   * Commit a mutation -- caller must apply nodes/edges to the live graph.
   */
  commit(id: string): StagedMutation | null {
    const m = this.mutations.get(id);
    if (!m || m.committed || m.discarded) return null;
    if (Date.now() > m.expires_at) {
      m.discarded = true;
      return null;
    }
    m.committed = true;
    return m;
  }

  /**
   * Discard a mutation.
   */
  discard(id: string): void {
    const m = this.mutations.get(id);
    if (m) m.discarded = true;
  }

  /**
   * Get pending (uncommitted, not expired) mutations for a trace.
   */
  getByTrace(traceId: string): StagedMutation[] {
    return [...this.mutations.values()].filter(
      (m) =>
        m.trace_id === traceId &&
        !m.committed &&
        !m.discarded &&
        Date.now() <= m.expires_at,
    );
  }

  /**
   * Get a specific mutation.
   */
  get(id: string): StagedMutation | null {
    return this.mutations.get(id) ?? null;
  }

  /**
   * Prune all expired mutations.
   */
  pruneExpired(): number {
    const now = Date.now();
    let count = 0;
    for (const [_id, m] of this.mutations) {
      if (!m.committed && !m.discarded && now > m.expires_at) {
        m.discarded = true;
        count++;
      }
    }
    return count;
  }

  /**
   * Get all pending mutations.
   */
  getAllPending(): StagedMutation[] {
    return [...this.mutations.values()].filter(
      (m) => !m.committed && !m.discarded && Date.now() <= m.expires_at,
    );
  }

  get size(): number {
    return this.mutations.size;
  }
}
