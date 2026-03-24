/**
 * GitHubMemorySync — backs up and syncs the 0agent knowledge graph to a
 * private GitHub repository using only the GitHub REST API.
 *
 * No git binary required. No server. GitHub IS the backend.
 *
 * What syncs:
 *   graph/nodes.json          — all entity/strategy/plan/context nodes
 *   graph/edges.json          — all edges with current learned weights
 *   graph/weight_events.jsonl — append-only learning history (for rollback)
 *   memory/personalities/     — one JSON per person entity
 *   memory/conversations.jsonl — conversation history
 *   skills/custom/            — user-created custom skill YAMLs
 *
 * Sync schedule:
 *   PULL — on daemon startup (always, fast, < 1MB)
 *   PUSH — every 30 minutes if changes exist + on `0agent memory sync`
 *
 * Cross-device: same graph on every machine.
 * Team: share the private repo → shared strategies and knowledge.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import type { KnowledgeGraph, SQLiteAdapter } from '@0agent/core';

const GITHUB_API = 'https://api.github.com';

export interface GitHubMemoryConfig {
  token: string;
  owner: string;
  repo: string;
}

export interface SyncResult {
  pushed: boolean;
  pulled: boolean;
  nodes_synced: number;
  edges_synced: number;
  error?: string;
  timestamp: number;
}

// ─── GitHub API helpers ──────────────────────────────────────────────────────

async function ghFetch(
  path: string,
  token: string,
  opts?: RequestInit,
): Promise<Response> {
  return fetch(`${GITHUB_API}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': '0agent/1.0',
      ...((opts?.headers as Record<string, string>) ?? {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
}

async function getFileSha(
  token: string,
  owner: string,
  repo: string,
  path: string,
): Promise<string | null> {
  try {
    const res = await ghFetch(`/repos/${owner}/${repo}/contents/${path}`, token);
    if (!res.ok) return null;
    const data = await res.json() as { sha: string };
    return data.sha;
  } catch { return null; }
}

async function putFile(
  token: string,
  owner: string,
  repo: string,
  path: string,
  content: string,
  message: string,
): Promise<boolean> {
  const sha = await getFileSha(token, owner, repo, path);
  const body: Record<string, unknown> = {
    message,
    content: Buffer.from(content).toString('base64'),
  };
  if (sha) body.sha = sha;

  const res = await ghFetch(`/repos/${owner}/${repo}/contents/${path}`, token, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  return res.ok;
}

async function getFile(
  token: string,
  owner: string,
  repo: string,
  path: string,
): Promise<string | null> {
  try {
    const res = await ghFetch(`/repos/${owner}/${repo}/contents/${path}`, token);
    if (!res.ok) return null;
    const data = await res.json() as { content: string };
    return Buffer.from(data.content, 'base64').toString('utf8');
  } catch { return null; }
}

// ─── GitHubMemorySync ─────────────────────────────────────────────────────────

export class GitHubMemorySync {
  private lastPushAt = 0;
  private lastPullAt = 0;
  private pendingChanges = false;

  constructor(
    private config: GitHubMemoryConfig,
    private adapter: SQLiteAdapter,
    private graph: KnowledgeGraph,
  ) {}

  /**
   * Push current graph state to GitHub.
   * Called automatically every 30 minutes and on `0agent memory sync`.
   */
  async push(message?: string): Promise<SyncResult> {
    const now = Date.now();
    const commitMsg = message ?? `sync: ${new Date(now).toISOString()}`;

    try {
      // Export nodes
      const nodes = this.adapter.queryNodes({});
      const nodesJson = JSON.stringify(nodes.map(n => ({
        id: n.id, graph_id: n.graph_id, label: n.label, type: n.type,
        visit_count: n.visit_count, metadata: n.metadata,
        subgraph_id: n.subgraph_id, created_at: n.created_at, last_seen: n.last_seen,
        // Omit embeddings — too large, recomputed locally
      })), null, 2);

      // Export edges
      const edges = this.adapter.getAllEdges();
      const edgesJson = JSON.stringify(edges.map(e => ({
        id: e.id, graph_id: e.graph_id, from_node: e.from_node, to_node: e.to_node,
        type: e.type, weight: e.weight, locked: e.locked, decay_rate: e.decay_rate,
        traversal_count: e.traversal_count, created_at: e.created_at,
      })), null, 2);

      // Export recent weight events (last 500)
      const weightEvents = this.getRecentWeightEvents(500);
      const weightEventsJsonl = weightEvents
        .map(e => JSON.stringify(e))
        .join('\n');

      // Export personality profiles (from node_content where is_personality_profile=true)
      const personalityMap = this.exportPersonalityProfiles();

      // Export conversations (last 1000)
      const conversations = this.getConversations(1000);
      const convsJsonl = conversations.map(c => JSON.stringify(c)).join('\n');

      // Push all files in parallel
      const { token, owner, repo } = this.config;
      const pushes = [
        putFile(token, owner, repo, 'graph/nodes.json', nodesJson, commitMsg),
        putFile(token, owner, repo, 'graph/edges.json', edgesJson, commitMsg),
      ];

      if (weightEventsJsonl) {
        pushes.push(putFile(token, owner, repo, 'graph/weight_events.jsonl', weightEventsJsonl, commitMsg));
      }
      if (convsJsonl) {
        pushes.push(putFile(token, owner, repo, 'memory/conversations.jsonl', convsJsonl, commitMsg));
      }

      // Push personality profiles
      for (const [entityId, profile] of Object.entries(personalityMap)) {
        pushes.push(
          putFile(token, owner, repo, `memory/personalities/${entityId}.json`,
            JSON.stringify(profile, null, 2), commitMsg)
        );
      }

      // Push custom skills
      const customSkillsDir = resolve(homedir(), '.0agent', 'skills', 'custom');
      if (existsSync(customSkillsDir)) {
        for (const file of readdirSync(customSkillsDir).filter(f => f.endsWith('.yaml'))) {
          const content = readFileSync(resolve(customSkillsDir, file), 'utf8');
          pushes.push(putFile(token, owner, repo, `skills/custom/${file}`, content, commitMsg));
        }
      }

      // Push README
      const readme = this.generateReadme(nodes.length, edges.length);
      pushes.push(putFile(token, owner, repo, 'README.md', readme, commitMsg));

      await Promise.all(pushes);

      this.lastPushAt = now;
      this.pendingChanges = false;

      return { pushed: true, pulled: false, nodes_synced: nodes.length, edges_synced: edges.length, timestamp: now };
    } catch (err) {
      return { pushed: false, pulled: false, nodes_synced: 0, edges_synced: 0,
               error: err instanceof Error ? err.message : String(err), timestamp: now };
    }
  }

  /**
   * Pull graph state from GitHub and merge into local SQLite.
   * Safe: never overwrites locked edges or newer local data.
   */
  async pull(): Promise<SyncResult> {
    const now = Date.now();
    try {
      const { token, owner, repo } = this.config;

      const [nodesJson, edgesJson] = await Promise.all([
        getFile(token, owner, repo, 'graph/nodes.json'),
        getFile(token, owner, repo, 'graph/edges.json'),
      ]);

      let nodeCount = 0, edgeCount = 0;

      if (nodesJson) {
        const nodes = JSON.parse(nodesJson) as Array<Record<string, unknown>>;
        for (const n of nodes) {
          const existing = this.graph.getNode(String(n.id));
          if (!existing) {
            // New node from remote — add it
            this.graph.addNode({
              id: String(n.id), graph_id: String(n.graph_id ?? 'root'),
              label: String(n.label), type: n.type as any,
              created_at: Number(n.created_at ?? now),
              last_seen: Number(n.last_seen ?? now),
              visit_count: Number(n.visit_count ?? 1),
              metadata: (n.metadata as Record<string, unknown>) ?? {},
              subgraph_id: n.subgraph_id ? String(n.subgraph_id) : null,
              embedding: null, embedding_model: null, embedding_at: null,
              content: [],
            });
            nodeCount++;
          }
          // Existing nodes: don't overwrite — local state takes priority
        }
      }

      if (edgesJson) {
        const edges = JSON.parse(edgesJson) as Array<Record<string, unknown>>;
        for (const e of edges) {
          const existing = this.graph.getEdge(String(e.id));
          if (!existing) {
            // New edge from remote — add it
            this.graph.addEdge({
              id: String(e.id), graph_id: String(e.graph_id ?? 'root'),
              from_node: String(e.from_node), to_node: String(e.to_node),
              type: e.type as any, weight: Number(e.weight ?? 0.5),
              locked: Boolean(e.locked), decay_rate: Number(e.decay_rate ?? 0.001),
              created_at: Number(e.created_at ?? now),
              last_traversed: null, traversal_count: Number(e.traversal_count ?? 0),
              metadata: {},
            });
            edgeCount++;
          } else if (!existing.locked) {
            // Existing unlocked edge: blend weights (remote 40%, local 60%)
            const remoteWeight = Number(e.weight ?? 0.5);
            const blended = existing.weight * 0.6 + remoteWeight * 0.4;
            if (Math.abs(blended - existing.weight) > 0.01) {
              this.adapter.forceUpdateEdgeWeight(existing.id, blended);
              edgeCount++;
            }
          }
        }
      }

      // Pull custom skills
      await this.pullCustomSkills();

      this.lastPullAt = now;
      return { pushed: false, pulled: true, nodes_synced: nodeCount, edges_synced: edgeCount, timestamp: now };
    } catch (err) {
      return { pushed: false, pulled: false, nodes_synced: 0, edges_synced: 0,
               error: err instanceof Error ? err.message : String(err), timestamp: now };
    }
  }

  /** Mark that changes exist — scheduler will push on next interval. */
  markDirty(): void { this.pendingChanges = true; }

  hasPendingChanges(): boolean { return this.pendingChanges; }

  getLastSyncTimes(): { pushed_at: number; pulled_at: number } {
    return { pushed_at: this.lastPushAt, pulled_at: this.lastPullAt };
  }

  // ─── Repo creation ─────────────────────────────────────────────────────────

  /**
   * Create the private GitHub repo for memory storage.
   * Returns the repo URL on success.
   */
  static async createRepo(token: string, owner: string, repoName: string): Promise<string> {
    const res = await ghFetch('/user/repos', token, {
      method: 'POST',
      body: JSON.stringify({
        name: repoName,
        description: '0agent memory — knowledge graph, personality profiles, conversation history',
        private: true,
        auto_init: true,  // creates main branch with README
      }),
    });

    if (!res.ok) {
      const err = await res.json() as { message?: string };
      // 422 = repo already exists — that's fine
      if (res.status !== 422) throw new Error(`Failed to create repo: ${err.message ?? res.status}`);
    }

    return `https://github.com/${owner}/${repoName}`;
  }

  /**
   * Verify token works and return the authenticated username.
   */
  static async verifyToken(token: string): Promise<string | null> {
    try {
      const res = await ghFetch('/user', token);
      if (!res.ok) return null;
      const user = await res.json() as { login: string };
      return user.login;
    } catch { return null; }
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private getRecentWeightEvents(limit: number): unknown[] {
    try {
      const db = (this.adapter as unknown as { db: { prepare: (s: string) => { all: (...a: unknown[]) => unknown[] } } }).db;
      return db.prepare(`SELECT * FROM weight_events ORDER BY created_at DESC LIMIT ?`).all(limit);
    } catch { return []; }
  }

  private getConversations(limit: number): unknown[] {
    try {
      const db = (this.adapter as unknown as { db: { prepare: (s: string) => { all: (...a: unknown[]) => unknown[] } } }).db;
      return db.prepare(`SELECT * FROM conversations ORDER BY created_at DESC LIMIT ?`).all(limit);
    } catch { return []; }
  }

  private exportPersonalityProfiles(): Record<string, unknown> {
    const profiles: Record<string, unknown> = {};
    try {
      // Find SIGNAL nodes with is_personality_profile=true
      const profileNodes = this.adapter.queryNodes({ type: 'signal' }).filter(
        n => n.metadata?.is_personality_profile
      );
      for (const node of profileNodes) {
        const entityId = node.metadata?.entity_id as string;
        if (entityId && node.content?.[0]?.data) {
          try { profiles[entityId] = JSON.parse(node.content[0].data); } catch {}
        }
      }
    } catch {}
    return profiles;
  }

  private async pullCustomSkills(): Promise<void> {
    const { token, owner, repo } = this.config;
    const dir = resolve(homedir(), '.0agent', 'skills', 'custom');

    try {
      const res = await ghFetch(`/repos/${owner}/${repo}/contents/skills/custom`, token);
      if (!res.ok) return;
      const files = await res.json() as Array<{ name: string; download_url: string }>;

      for (const file of files.filter(f => f.name.endsWith('.yaml'))) {
        const content = await getFile(token, owner, repo, `skills/custom/${file.name}`);
        if (content) {
          const { mkdirSync } = await import('node:fs');
          mkdirSync(dir, { recursive: true });
          writeFileSync(resolve(dir, file.name), content, 'utf8');
        }
      }
    } catch {}
  }

  private generateReadme(nodeCount: number, edgeCount: number): string {
    return `# 0agent Memory

> Private knowledge graph — backed up automatically by [0agent](https://github.com/cadetmaze/0agentv1)

**Last synced:** ${new Date().toISOString()}

## Contents

| File | Description |
|------|-------------|
| \`graph/nodes.json\` | ${nodeCount} entities, strategies, plans, context nodes |
| \`graph/edges.json\` | ${edgeCount} relationships with learned weights |
| \`graph/weight_events.jsonl\` | Full learning history (append-only) |
| \`memory/personalities/\` | Communication style + preferences per person |
| \`memory/conversations.jsonl\` | Conversation history |
| \`skills/custom/\` | Custom skill definitions |

## Cross-device sync

\`\`\`bash
# On a new machine:
0agent memory connect github --repo ${this.config.owner}/${this.config.repo}
\`\`\`

## Rollback

\`\`\`bash
# Restore to a previous state:
git log --oneline                    # find the commit
git checkout <commit> graph/         # restore graph files
0agent memory import                 # import into local SQLite
\`\`\`

---
*This repo is managed by 0agent. Do not edit files manually.*
`;
  }
}
