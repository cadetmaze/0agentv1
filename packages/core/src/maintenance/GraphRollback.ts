import type { KnowledgeGraph } from '../graph/KnowledgeGraph.js';
import type { SQLiteAdapter } from '../storage/adapters/SQLiteAdapter.js';
import type { WeightEvent } from '../storage/adapters/SQLiteAdapter.js';
import type { GraphCheckpointManager, CheckpointSnapshot } from './GraphCheckpoint.js';
import type { WeightEventLog } from '../storage/WeightEventLog.js';

export type RollbackMode =
  | { type: 'checkpoint'; checkpoint_id: string }
  | { type: 'trace'; trace_id: string }
  | { type: 'verifier'; verifier_name: string };

export interface RollbackResult {
  mode: RollbackMode;
  edges_reverted: number;
  nodes_restored: number;
  traces_undone: number;
  weight_events_reversed: number;
}

export class GraphRollback {
  constructor(
    private graph: KnowledgeGraph,
    private adapter: SQLiteAdapter,
    private weightLog: WeightEventLog,
    private checkpointManager: GraphCheckpointManager,
  ) {}

  /**
   * Dispatch to the appropriate rollback strategy based on mode.
   */
  async rollback(mode: RollbackMode): Promise<RollbackResult> {
    switch (mode.type) {
      case 'checkpoint':
        return this.rollbackToCheckpoint(mode.checkpoint_id);
      case 'trace':
        return this.rollbackTrace(mode.trace_id);
      case 'verifier':
        return this.rollbackVerifier(mode.verifier_name);
    }
  }

  // ── Mode 1: Checkpoint ──────────────────────────────────────────────
  //
  // Reverse all weight_events created after the checkpoint timestamp.
  // For each event (newest first): restore the edge to event.old_weight.
  // Re-insert any nodes/edges from the checkpoint snapshot that no longer
  // exist in the live graph.

  private async rollbackToCheckpoint(checkpointId: string): Promise<RollbackResult> {
    const checkpoint = this.checkpointManager.get(checkpointId);
    if (!checkpoint) {
      throw new Error(`Checkpoint not found: ${checkpointId}`);
    }

    const snapshot = await this.checkpointManager.getSnapshot(checkpointId);
    if (!snapshot) {
      throw new Error(`Checkpoint snapshot could not be loaded: ${checkpointId}`);
    }

    const result: RollbackResult = {
      mode: { type: 'checkpoint', checkpoint_id: checkpointId },
      edges_reverted: 0,
      nodes_restored: 0,
      traces_undone: 0,
      weight_events_reversed: 0,
    };

    // Collect all weight events after the checkpoint timestamp by scanning
    // edges present in the snapshot. We go through each snapshot edge and
    // check its event history.
    const eventsAfterCheckpoint: WeightEvent[] = [];

    const snapshotEdgeIds = new Set(snapshot.edges.map((e) => e.id));

    // Also check edges that might exist now but not in the snapshot
    const currentEdges = this.graph.getAllEdges();
    const allEdgeIds = new Set([
      ...snapshotEdgeIds,
      ...currentEdges.map((e) => e.id),
    ]);

    for (const edgeId of allEdgeIds) {
      const events = this.weightLog.getByEdge(edgeId);
      for (const evt of events) {
        if (evt.created_at > checkpoint.created_at) {
          eventsAfterCheckpoint.push(evt);
        }
      }
    }

    // Sort newest first and reverse each event
    eventsAfterCheckpoint.sort((a, b) => b.created_at - a.created_at);

    for (const evt of eventsAfterCheckpoint) {
      const edge = this.adapter.getEdge(evt.edge_id);
      if (edge) {
        this.adapter.forceUpdateEdgeWeight(evt.edge_id, evt.old_weight);
        result.edges_reverted++;
      }
      result.weight_events_reversed++;
    }

    // Re-insert nodes from snapshot that are missing in the live graph
    for (const snapshotNode of snapshot.nodes) {
      const existing = this.graph.getNode(snapshotNode.id);
      if (!existing) {
        this.graph.addNode(snapshotNode);
        result.nodes_restored++;
      }
    }

    // Re-insert edges from snapshot that are missing in the live graph
    for (const snapshotEdge of snapshot.edges) {
      const existing = this.adapter.getEdge(snapshotEdge.id);
      if (!existing) {
        this.graph.addEdge(snapshotEdge);
        result.edges_reverted++;
      }
    }

    return result;
  }

  // ── Mode 2: Trace ──────────────────────────────────────────────────
  //
  // Reverse all weight_events associated with this trace_id.
  // For each (newest first): restore the edge to event.old_weight.

  private async rollbackTrace(traceId: string): Promise<RollbackResult> {
    const events = this.weightLog.getByTrace(traceId);

    const result: RollbackResult = {
      mode: { type: 'trace', trace_id: traceId },
      edges_reverted: 0,
      nodes_restored: 0,
      traces_undone: 1,
      weight_events_reversed: 0,
    };

    if (events.length === 0) {
      result.traces_undone = 0;
      return result;
    }

    // Sort newest first to reverse in correct order
    const sorted = [...events].sort((a, b) => b.created_at - a.created_at);

    for (const evt of sorted) {
      const edge = this.adapter.getEdge(evt.edge_id);
      if (edge) {
        this.adapter.forceUpdateEdgeWeight(evt.edge_id, evt.old_weight);
        result.edges_reverted++;
      }
      result.weight_events_reversed++;
    }

    return result;
  }

  // ── Mode 3: Verifier ──────────────────────────────────────────────
  //
  // Find all traces whose metadata references this verifier name,
  // then rollback each trace individually.

  private async rollbackVerifier(verifierName: string): Promise<RollbackResult> {
    const result: RollbackResult = {
      mode: { type: 'verifier', verifier_name: verifierName },
      edges_reverted: 0,
      nodes_restored: 0,
      traces_undone: 0,
      weight_events_reversed: 0,
    };

    // Query all traces (paginated scan) and filter for ones resolved by this verifier.
    // The verifier name is stored in trace metadata under "verifier" or "verifier_name".
    const allTraces = this.adapter.queryTraces({ limit: 100_000 });

    const matchingTraces = allTraces.filter((t) => {
      const meta = t.metadata;
      return (
        meta.verifier === verifierName ||
        meta.verifier_name === verifierName ||
        meta.resolved_by === verifierName
      );
    });

    for (const trace of matchingTraces) {
      const traceResult = await this.rollbackTrace(trace.id);
      result.edges_reverted += traceResult.edges_reverted;
      result.nodes_restored += traceResult.nodes_restored;
      result.traces_undone += traceResult.traces_undone;
      result.weight_events_reversed += traceResult.weight_events_reversed;
    }

    return result;
  }
}
