import type { KnowledgeGraph } from '../graph/KnowledgeGraph.js';
import type { GraphConstructor } from './GraphConstructor.js';
import type { StagedMutationStore } from './StagedMutations.js';
import type { HypothesisManager } from './HypothesisManager.js';

const BOOTSTRAP_NODE_THRESHOLD = 10;

export class BootstrapProtocol {
  constructor(
    private graph: KnowledgeGraph,
    private constructor_: GraphConstructor,
    private mutations: StagedMutationStore,
    private hypotheses: HypothesisManager,
  ) {}

  /**
   * Check if the graph is in bootstrap mode (< 10 nodes).
   */
  shouldBootstrap(): boolean {
    return this.graph.nodeCount() < BOOTSTRAP_NODE_THRESHOLD;
  }

  /**
   * Run the bootstrap protocol for a task:
   * 1. Use GraphConstructor to generate a proposal from LLM
   * 2. Store as StagedMutation
   * 3. Register proposed nodes as hypotheses
   * Returns mutation ID, or null if proposal generation failed.
   */
  async bootstrap(
    task: string,
    traceId: string,
    graphId: string = 'root',
  ): Promise<string | null> {
    const mutationId = await this.constructor_.propose(task, traceId, graphId);
    if (!mutationId) return null;

    // Register proposed nodes as hypotheses
    const mutation = this.mutations.get(mutationId);
    if (mutation) {
      for (const node of mutation.proposed_nodes) {
        this.hypotheses.register(node.id);
      }
    }

    return mutationId;
  }

  /**
   * Called when a trace outcome is received.
   * If positive: commit the staged mutation to live graph.
   * If negative: discard the mutation.
   */
  async resolveOutcome(traceId: string, positive: boolean): Promise<void> {
    const pendingMutations = this.mutations.getByTrace(traceId);

    for (const mutation of pendingMutations) {
      if (positive) {
        const committed = this.mutations.commit(mutation.id);
        if (committed) {
          // Apply to live graph
          for (const node of committed.proposed_nodes) {
            this.graph.addNode(node);
          }
          for (const edge of committed.proposed_edges) {
            this.graph.addEdge(edge);
          }
          // Record positive outcome for hypotheses
          for (const node of committed.proposed_nodes) {
            this.hypotheses.recordOutcome(node.id, true);
          }
        }
      } else {
        this.mutations.discard(mutation.id);
        // Record negative outcome for hypotheses
        for (const node of mutation.proposed_nodes) {
          this.hypotheses.recordOutcome(node.id, false);
        }
      }
    }
  }

  /**
   * Run maintenance: prune expired hypotheses and mutations.
   */
  runMaintenance(): { hypothesesPruned: number; mutationsPruned: number } {
    return {
      hypothesesPruned: this.hypotheses.pruneExpired(),
      mutationsPruned: this.mutations.pruneExpired(),
    };
  }
}
