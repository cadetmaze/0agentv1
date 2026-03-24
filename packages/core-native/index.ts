import * as fallback from './fallback.js';

let native: typeof fallback | null = null;
try {
  // Dynamic require for native .node file
  native = require('./core-native.node') as typeof fallback;
} catch {
  // Native module not available — use TypeScript fallback
}

export const bfs_top_k = native?.bfs_top_k ?? fallback.bfs_top_k;
export const batch_decay = native?.batch_decay ?? fallback.batch_decay;
