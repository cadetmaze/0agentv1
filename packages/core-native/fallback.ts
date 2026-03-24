// Pure TypeScript implementations matching the Rust module's interface.
// Used as a fallback when the native .node binary is unavailable.

interface EdgeData {
  id: string;
  from_node: string;
  to_node: string;
  weight: number;
  locked: boolean;
  decay_rate: number;
  last_traversed: number | null;
  created_at: number;
}

interface PathResult {
  node_ids: string[];
  edge_ids: string[];
  weight_product: number;
}

interface DecayUpdate {
  edge_id: string;
  new_weight: number;
}

/**
 * BFS from startNode returning top-k paths by descending weight product.
 */
export function bfs_top_k(
  startNode: string,
  edgesJson: string,
  maxDepth: number,
  topK: number,
): string {
  let edges: EdgeData[];
  try {
    edges = JSON.parse(edgesJson);
  } catch {
    return '[]';
  }

  // Build adjacency map: from_node -> edge indices
  const adjacency = new Map<string, number[]>();
  for (let i = 0; i < edges.length; i++) {
    const list = adjacency.get(edges[i].from_node);
    if (list) {
      list.push(i);
    } else {
      adjacency.set(edges[i].from_node, [i]);
    }
  }

  // BFS queue entries
  type QueueEntry = {
    current: string;
    nodeIds: string[];
    edgeIds: string[];
    weightProduct: number;
    visited: Set<string>;
  };

  const queue: QueueEntry[] = [];
  queue.push({
    current: startNode,
    nodeIds: [startNode],
    edgeIds: [],
    weightProduct: 1.0,
    visited: new Set([startNode]),
  });

  const allPaths: PathResult[] = [];

  while (queue.length > 0) {
    const entry = queue.shift()!;
    const depth = entry.edgeIds.length;

    // Record paths with at least one edge
    if (depth > 0) {
      allPaths.push({
        node_ids: entry.nodeIds,
        edge_ids: entry.edgeIds,
        weight_product: entry.weightProduct,
      });
    }

    if (depth >= maxDepth) continue;

    const neighbors = adjacency.get(entry.current);
    if (!neighbors) continue;

    for (const edgeIdx of neighbors) {
      const edge = edges[edgeIdx];
      const nextNode = edge.to_node;

      if (entry.visited.has(nextNode)) continue;

      const newVisited = new Set(entry.visited);
      newVisited.add(nextNode);

      queue.push({
        current: nextNode,
        nodeIds: [...entry.nodeIds, nextNode],
        edgeIds: [...entry.edgeIds, edge.id],
        weightProduct: entry.weightProduct * edge.weight,
        visited: newVisited,
      });
    }
  }

  // Sort descending by weight product, take top-k
  allPaths.sort((a, b) => b.weight_product - a.weight_product);
  return JSON.stringify(allPaths.slice(0, topK));
}

/**
 * Batch-apply time-based decay to edges, moving weights toward 0.5.
 */
export function batch_decay(
  edgesJson: string,
  nowMs: number,
  graceMs: number,
  maxDelta: number,
): string {
  let edges: EdgeData[];
  try {
    edges = JSON.parse(edgesJson);
  } catch {
    return '[]';
  }

  const updates: DecayUpdate[] = [];

  for (const edge of edges) {
    if (edge.locked) continue;

    const reference = edge.last_traversed ?? edge.created_at;
    const ageMs = nowMs - reference;

    if (ageMs <= graceMs) continue;

    const distance = Math.abs(edge.weight - 0.5);
    if (distance < 1e-12) continue;

    const hours = ageMs / 3_600_000;
    const delta = Math.min(edge.decay_rate * distance * hours, maxDelta);

    let newWeight: number;
    if (edge.weight > 0.5) {
      newWeight = Math.max(edge.weight - delta, 0.5);
    } else {
      newWeight = Math.min(edge.weight + delta, 0.5);
    }

    if (Math.abs(newWeight - edge.weight) > 1e-15) {
      updates.push({ edge_id: edge.id, new_weight: newWeight });
    }
  }

  return JSON.stringify(updates);
}
