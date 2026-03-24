/**
 * BlinkingMemory — Mid-term session summaries for 0agent Phase 4.
 *
 * Stores prose-compressed summaries of recent sessions, bridging
 * the gap between WorkingMemory (per-request LRU) and ArchivalMemory
 * (long-term compressed storage). Older summaries are evicted when
 * the capacity limit is reached.
 */

export interface SessionSummary {
  session_id: string;
  summary: string;
  entities_mentioned: string[];
  created_at: number;
}

export class BlinkingMemory {
  private summaries: Map<string, SessionSummary> = new Map();
  private maxSummaries: number;

  constructor(maxSummaries: number = 50) {
    this.maxSummaries = maxSummaries;
  }

  /**
   * Add a session summary. Evicts the oldest summary if at capacity.
   */
  addSummary(summary: SessionSummary): void {
    if (this.summaries.size >= this.maxSummaries) {
      // Remove oldest (first entry in insertion order)
      const oldest = this.summaries.keys().next().value;
      if (oldest !== undefined) this.summaries.delete(oldest);
    }
    this.summaries.set(summary.session_id, summary);
  }

  /**
   * Retrieve a summary by session ID.
   */
  getSummary(sessionId: string): SessionSummary | null {
    return this.summaries.get(sessionId) ?? null;
  }

  /**
   * Get the N most recent summaries (oldest to newest).
   */
  getRecentSummaries(n: number): SessionSummary[] {
    return Array.from(this.summaries.values()).slice(-n);
  }

  /** Number of stored summaries. */
  get size(): number {
    return this.summaries.size;
  }
}
