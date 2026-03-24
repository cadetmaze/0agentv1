/**
 * ArchivalMemory — Long-term compressed summaries for 0agent Phase 4.
 *
 * Stored in ObjectStore. Phase 4 stub: interface defined,
 * full ObjectStore integration deferred to Phase 5.
 */

export interface ArchivalEntry {
  id: string;
  /** Period label, e.g. "2026-03-W12" */
  period: string;
  summary: string;
  entity_ids: string[];
  /** ObjectStore reference key */
  object_ref: string;
  created_at: number;
}

export class ArchivalMemory {
  private entries: ArchivalEntry[] = [];

  /** Append an archival entry. */
  add(entry: ArchivalEntry): void {
    this.entries.push(entry);
  }

  /** Find an entry by period label. */
  getByPeriod(period: string): ArchivalEntry | undefined {
    return this.entries.find((e) => e.period === period);
  }

  /** Get the N most recent entries. */
  getRecent(n: number): ArchivalEntry[] {
    return this.entries.slice(-n);
  }

  /** Total number of archival entries. */
  get size(): number {
    return this.entries.length;
  }
}
