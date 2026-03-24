import type { SQLiteAdapter } from '../storage/adapters/SQLiteAdapter.js';
import type { GraphEdge } from '../graph/GraphEdge.js';

export interface SnapshotEntry {
  edge_id: string;
  weight_at_snapshot: number;
  version: number;
}

export interface SessionSnapshotData {
  session_id: string;
  created_at: number;
  edges: Map<string, SnapshotEntry>;
  pending_updates: Map<string, number>;
}

export interface MergeResult {
  applied: number;
  conflicted: number;
  skipped: number;
}

/**
 * Optimistic Concurrency Control (OCC) snapshot isolation per session.
 *
 * Each session captures a snapshot of edge weights at the start, records
 * pending updates during execution, and merges them back at the end.
 * Conflicts are detected by comparing edge versions (number of weight events)
 * at snapshot time vs merge time.
 */
export class SessionSnapshotManager {
  private snapshots = new Map<string, SessionSnapshotData>();

  constructor(private adapter: SQLiteAdapter) {}

  /**
   * Create a snapshot for a session, capturing current weight and version
   * for each specified edge.
   */
  createSnapshot(sessionId: string, edgeIds: string[]): SessionSnapshotData {
    const snapshot: SessionSnapshotData = {
      session_id: sessionId,
      created_at: Date.now(),
      edges: new Map(),
      pending_updates: new Map(),
    };

    for (const edgeId of edgeIds) {
      const edge = this.adapter.getEdge(edgeId);
      if (edge) {
        snapshot.edges.set(edgeId, {
          edge_id: edgeId,
          weight_at_snapshot: edge.weight,
          version: this.getEdgeVersion(edgeId),
        });
      }
    }

    this.snapshots.set(sessionId, snapshot);
    return snapshot;
  }

  /**
   * Record a pending weight update within an active session snapshot.
   * The update is buffered and only applied on merge.
   */
  recordUpdate(sessionId: string, edgeId: string, newWeight: number): void {
    const snapshot = this.snapshots.get(sessionId);
    if (snapshot) {
      snapshot.pending_updates.set(edgeId, newWeight);
    }
  }

  /**
   * Merge a session's pending updates back into the live graph.
   *
   * Conflict resolution strategy:
   * - If no version change since snapshot: apply via CAS (updateEdgeWeight).
   * - If version changed AND session succeeded: session wins, force write.
   * - If version changed AND session failed: skip the update.
   * - If the edge no longer exists: skip.
   */
  mergeSnapshot(sessionId: string, sessionSucceeded: boolean): MergeResult {
    const snapshot = this.snapshots.get(sessionId);
    if (!snapshot) {
      return { applied: 0, conflicted: 0, skipped: 0 };
    }

    const result: MergeResult = { applied: 0, conflicted: 0, skipped: 0 };

    for (const [edgeId, pendingWeight] of snapshot.pending_updates) {
      const current = this.adapter.getEdge(edgeId);
      if (!current) {
        result.skipped++;
        continue;
      }

      const snapshotEntry = snapshot.edges.get(edgeId);
      const currentVersion = this.getEdgeVersion(edgeId);

      // Check if the edge has been modified since our snapshot
      if (snapshotEntry && currentVersion > snapshotEntry.version) {
        // Conflict detected: another session modified this edge
        result.conflicted++;

        if (sessionSucceeded) {
          // Session wins -- force the write (last-writer-wins for successful sessions)
          this.adapter.forceUpdateEdgeWeight(edgeId, pendingWeight);
          result.applied++;
        } else {
          result.skipped++;
        }
      } else {
        // No conflict -- attempt CAS update using expected weight
        const expectedWeight = snapshotEntry
          ? snapshotEntry.weight_at_snapshot
          : current.weight;

        const success = this.adapter.updateEdgeWeight(edgeId, pendingWeight, expectedWeight);
        if (success) {
          result.applied++;
        } else {
          // CAS failed (weight changed between version check and CAS)
          result.conflicted++;
          result.skipped++;
        }
      }
    }

    // Clean up the snapshot after merge
    this.snapshots.delete(sessionId);
    return result;
  }

  /**
   * Retrieve the snapshot data for an active session.
   */
  getSnapshot(sessionId: string): SessionSnapshotData | null {
    return this.snapshots.get(sessionId) ?? null;
  }

  /**
   * Discard a session snapshot without merging.
   */
  discardSnapshot(sessionId: string): void {
    this.snapshots.delete(sessionId);
  }

  /**
   * Derive an edge's version from the number of weight events recorded for it.
   */
  private getEdgeVersion(edgeId: string): number {
    return this.adapter.getWeightEvents(edgeId).length;
  }
}
