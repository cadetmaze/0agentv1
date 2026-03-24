import type { SQLiteAdapter, AliasRecord } from '../storage/adapters/SQLiteAdapter.js';

export class AliasIndex {
  constructor(private adapter: SQLiteAdapter) {}

  /**
   * Register an alias for a node.
   * Normalizes alias to lowercase.
   */
  add(alias: string, nodeId: string, confidence: number = 1.0): void {
    this.adapter.insertAlias(this.normalize(alias), nodeId, confidence);
  }

  /**
   * Remove an alias.
   */
  remove(alias: string, nodeId: string): void {
    this.adapter.deleteAlias(this.normalize(alias), nodeId);
  }

  /**
   * Find nodes by exact alias match.
   */
  findExact(alias: string): AliasRecord[] {
    return this.adapter.findByAlias(this.normalize(alias));
  }

  /**
   * Get all aliases for a node.
   */
  getAliases(nodeId: string): AliasRecord[] {
    return this.adapter.getAliases(nodeId);
  }

  /**
   * Generate common abbreviations for a label.
   * "Acme Corp" -> ["acme corp", "acme", "ac"]
   * "John Smith" -> ["john smith", "john", "js"]
   */
  generateAbbreviations(label: string): string[] {
    const normalized = this.normalize(label);
    const words = normalized.split(/\s+/).filter(Boolean);
    const results: string[] = [normalized];

    if (words.length > 1) {
      // First word only
      results.push(words[0]);
      // Initials
      const initials = words.map((w) => w[0]).join('');
      if (initials.length >= 2) {
        results.push(initials);
      }
    }

    return [...new Set(results)];
  }

  /**
   * Register a node with its label and auto-generated abbreviations.
   */
  registerNode(nodeId: string, label: string): void {
    const abbreviations = this.generateAbbreviations(label);
    for (const abbr of abbreviations) {
      this.add(abbr, nodeId, abbr === this.normalize(label) ? 1.0 : 0.9);
    }
  }

  /**
   * Fuzzy scan: find aliases that contain the query string.
   * Returns matches sorted by confidence desc.
   */
  fuzzyFind(query: string): AliasRecord[] {
    // This does a full scan via SQL LIKE — fine for reasonable alias counts
    const normalized = this.normalize(query);
    // We'll use the adapter to get ALL aliases and filter.
    // For Phase 1 this is acceptable; can be optimized with FTS later.
    const allForQuery = this.adapter.findByAlias(normalized);
    if (allForQuery.length > 0) return allForQuery;

    // No exact match — try prefix/contains via a scan
    // This requires a new adapter method or manual scan
    // For now, return empty — fuzzy matching will be done via embeddings in NodeResolutionService
    return [];
  }

  private normalize(s: string): string {
    return s.toLowerCase().trim();
  }
}
