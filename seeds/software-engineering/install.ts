import type { KnowledgeGraph } from '@0agent/core';
import { createNode, createEdge, NodeType, EdgeType } from '@0agent/core';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

interface SeedNodeData {
  id?: string;
  label: string;
  type: string;
  metadata?: Record<string, unknown>;
}

interface SeedEdgeData {
  id?: string;
  from: string;
  to: string;
  type?: string;
  weight?: number;
}

interface SeedGraph {
  nodes: SeedNodeData[];
  edges: SeedEdgeData[];
}

export async function installSeed(
  graph: KnowledgeGraph,
  graphId: string = 'root',
): Promise<{ nodes: number; edges: number }> {
  // Check idempotency
  const existing = graph.nodeCount(graphId);
  if (existing > 0) {
    console.log('[Seed] software-engineering already installed, skipping');
    return { nodes: 0, edges: 0 };
  }

  // Read graph data from the same directory
  const dir = dirname(fileURLToPath(import.meta.url));
  const data: SeedGraph = JSON.parse(
    readFileSync(join(dir, 'sprint-workflow.json'), 'utf8'),
  );

  let nodeCount = 0;
  let edgeCount = 0;

  for (const n of data.nodes) {
    graph.addNode(
      createNode({
        id: n.id ?? crypto.randomUUID(),
        graph_id: graphId,
        label: n.label,
        type: n.type as NodeType,
        metadata: n.metadata ?? {},
      }),
    );
    nodeCount++;
  }

  for (const e of data.edges) {
    graph.addEdge(
      createEdge({
        id: e.id ?? crypto.randomUUID(),
        graph_id: graphId,
        from_node: e.from,
        to_node: e.to,
        type: (e.type as EdgeType) ?? EdgeType.LEADS_TO,
        weight: e.weight ?? 0.5,
      }),
    );
    edgeCount++;
  }

  console.log(
    `[Seed] Installed software-engineering: ${nodeCount} nodes, ${edgeCount} edges`,
  );
  return { nodes: nodeCount, edges: edgeCount };
}
