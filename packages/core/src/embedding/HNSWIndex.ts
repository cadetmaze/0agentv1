export interface HNSWSearchResult {
  id: string;
  distance: number;
  similarity: number; // 1 - distance for cosine
}

export interface HNSWConfig {
  dimensions: number;
  metric?: 'cos' | 'l2';
  connectivity?: number; // M parameter, default 16
  ef_construction?: number; // default 200
}

export class HNSWIndex {
  private config: HNSWConfig;
  // In-memory fallback: Map<id, Float32Array>
  private vectors: Map<string, Float32Array>;
  private usearchIndex: unknown | null = null;

  constructor(config: HNSWConfig) {
    this.config = {
      dimensions: config.dimensions,
      metric: config.metric ?? 'cos',
      connectivity: config.connectivity ?? 16,
      ef_construction: config.ef_construction ?? 200,
    };
    this.vectors = new Map();
  }

  static async open(path: string, config: HNSWConfig): Promise<HNSWIndex> {
    const index = new HNSWIndex(config);
    // Try to load usearch, fall back to brute-force
    try {
      // Dynamic import — may not be installed
      // @ts-expect-error usearch may not be installed
      const usearch = await import('usearch');
      // TODO: initialize usearch index from path
      void usearch;
      void path;
    } catch {
      // Brute-force fallback — fine for <10K vectors
    }
    return index;
  }

  add(id: string, vector: Float32Array): void {
    if (vector.length !== this.config.dimensions) {
      throw new Error(
        `Vector dimension mismatch: expected ${this.config.dimensions}, got ${vector.length}`,
      );
    }
    this.vectors.set(id, vector);
  }

  remove(id: string): void {
    this.vectors.delete(id);
  }

  search(query: Float32Array, limit: number = 10): HNSWSearchResult[] {
    if (this.vectors.size === 0) return [];

    // Brute-force cosine similarity
    const results: HNSWSearchResult[] = [];
    for (const [id, vec] of this.vectors) {
      const sim = this.cosineSimilarity(query, vec);
      results.push({ id, distance: 1 - sim, similarity: sim });
    }
    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, limit);
  }

  private cosineSimilarity(a: Float32Array, b: Float32Array): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  get size(): number {
    return this.vectors.size;
  }

  get dimensions(): number {
    return this.config.dimensions;
  }

  // Serialize for snapshot injection into subagents
  toJSON(): { entries: Array<{ id: string; vector: number[] }> } {
    const entries: Array<{ id: string; vector: number[] }> = [];
    for (const [id, vec] of this.vectors) {
      entries.push({ id, vector: Array.from(vec) });
    }
    return { entries };
  }

  static fromJSON(
    data: { entries: Array<{ id: string; vector: number[] }> },
    config: HNSWConfig,
  ): HNSWIndex {
    const index = new HNSWIndex(config);
    for (const entry of data.entries) {
      index.add(entry.id, new Float32Array(entry.vector));
    }
    return index;
  }
}
