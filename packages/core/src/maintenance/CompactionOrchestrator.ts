import type { KnowledgeGraph } from '../graph/KnowledgeGraph.js';
import { EdgePruner } from './EdgePruner.js';
import { SubgraphArchiver } from './SubgraphArchiver.js';
import { NodeDeduplicator } from './NodeDeduplicator.js';

export interface CompactionSchedule {
  edge_pruning_interval_ms: number;   // default 24h
  archival_trigger_nodes: number;     // default 5000
  deduplication_interval_ms: number;  // default 7 days
}

const DEFAULT_SCHEDULE: CompactionSchedule = {
  edge_pruning_interval_ms: 24 * 60 * 60 * 1000,         // 24 hours
  archival_trigger_nodes: 5000,
  deduplication_interval_ms: 7 * 24 * 60 * 60 * 1000,    // 7 days
};

export class CompactionOrchestrator {
  private lastPruneAt = 0;
  private lastDedupAt = 0;

  constructor(
    private edgePruner: EdgePruner,
    private archiver: SubgraphArchiver,
    private deduplicator: NodeDeduplicator,
    private graph: KnowledgeGraph,
    private schedule: CompactionSchedule = DEFAULT_SCHEDULE,
  ) {}

  async runCompaction(activeSessionCount?: number): Promise<void> {
    const now = Date.now();

    // Safety: never run during active sessions
    if (activeSessionCount && activeSessionCount > 0) {
      console.log(`[Compaction] Deferring: ${activeSessionCount} active sessions`);
      return;
    }

    // Level 1: Edge Pruning (daily)
    if (now - this.lastPruneAt >= this.schedule.edge_pruning_interval_ms) {
      console.log('[Compaction] Level 1: Running edge pruning...');
      const pruneResult = this.edgePruner.prune();
      console.log(
        `[Compaction] Level 1 complete: pruned ${pruneResult.pruned_count} edges ` +
        `(locked=${pruneResult.skipped_locked}, hypothesis=${pruneResult.skipped_hypothesis}, ` +
        `skill=${pruneResult.skipped_skill}, active=${pruneResult.skipped_active})`,
      );
      this.lastPruneAt = now;
    }

    // Level 2: Subgraph Archival (if node count exceeds threshold)
    const nodeCount = this.graph.nodeCount();
    if (nodeCount > this.schedule.archival_trigger_nodes) {
      console.log(`[Compaction] Level 2: Running subgraph archival (${nodeCount} nodes)...`);
      const archiveResult = await this.archiver.archiveCold();
      console.log(
        `[Compaction] Level 2 complete: archived ${archiveResult.archived_count} subgraphs`,
      );
    }

    // Level 3: Node Deduplication (weekly)
    if (now - this.lastDedupAt >= this.schedule.deduplication_interval_ms) {
      console.log('[Compaction] Level 3: Running node deduplication...');
      const dedupResult = this.deduplicator.run();
      console.log(
        `[Compaction] Level 3 complete: merged ${dedupResult.merged_count} nodes ` +
        `(${dedupResult.candidates_found} candidates found)`,
      );
      this.lastDedupAt = now;
    }

    // Level 4: LRU eviction handled by WorkingMemory automatically
  }

  shouldRun(now?: number): boolean {
    const ts = now ?? Date.now();

    const pruningDue = ts - this.lastPruneAt >= this.schedule.edge_pruning_interval_ms;
    const dedupDue = ts - this.lastDedupAt >= this.schedule.deduplication_interval_ms;
    const nodeCountHigh = this.graph.nodeCount() > this.schedule.archival_trigger_nodes;

    return pruningDue || dedupDue || nodeCountHigh;
  }
}
