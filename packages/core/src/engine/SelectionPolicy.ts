import type { GraphEdge } from '../graph/GraphEdge.js';

export interface SelectionConfig {
  epsilon: number;      // default 0.15 — probability of random exploration
  temperature: number;  // default 0.5 — softmax temperature for exploitation
}

export interface SelectionResult {
  edge: GraphEdge;
  mode: 'exploit' | 'explore';
  score: number;
}

export class SelectionPolicy {
  private config: SelectionConfig;
  private rng: () => number;  // injectable RNG for testing

  constructor(config?: Partial<SelectionConfig>, rng?: () => number) {
    this.config = {
      epsilon: config?.epsilon ?? 0.15,
      temperature: config?.temperature ?? 0.5,
    };
    this.rng = rng ?? Math.random;
  }

  /**
   * Select an edge from candidates using epsilon-greedy.
   * - With probability epsilon: random selection (explore)
   * - Otherwise: temperature-softmax weighted by edge weight (exploit)
   * Returns null if no candidates.
   */
  select(candidates: GraphEdge[]): SelectionResult | null {
    if (candidates.length === 0) return null;
    if (candidates.length === 1) {
      return { edge: candidates[0], mode: 'exploit', score: candidates[0].weight };
    }

    const roll = this.rng();

    if (roll < this.config.epsilon) {
      // EXPLORE: uniform random
      const idx = Math.floor(this.rng() * candidates.length);
      return { edge: candidates[idx], mode: 'explore', score: candidates[idx].weight };
    }

    // EXPLOIT: temperature-softmax
    return this.softmaxSelect(candidates);
  }

  /**
   * Softmax selection weighted by edge weight / temperature.
   * Higher temperature = more uniform. Lower = more greedy.
   */
  private softmaxSelect(candidates: GraphEdge[]): SelectionResult {
    const weights = candidates.map(e => e.weight / this.config.temperature);
    const maxW = Math.max(...weights);
    const exps = weights.map(w => Math.exp(w - maxW));  // subtract max for numerical stability
    const sumExp = exps.reduce((a, b) => a + b, 0);
    const probs = exps.map(e => e / sumExp);

    // Weighted random selection
    let r = this.rng();
    for (let i = 0; i < probs.length; i++) {
      r -= probs[i];
      if (r <= 0) {
        return { edge: candidates[i], mode: 'exploit', score: candidates[i].weight };
      }
    }

    // Fallback (floating point edge case)
    const last = candidates[candidates.length - 1];
    return { edge: last, mode: 'exploit', score: last.weight };
  }

  getConfig(): SelectionConfig {
    return { ...this.config };
  }
}
