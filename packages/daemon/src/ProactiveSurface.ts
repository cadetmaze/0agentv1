import { execSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { NodeType, ContentType, createNode, type KnowledgeGraph } from '@0agent/core';
import type { IEventBus } from './WebSocketEvents.js';

export type InsightType = 'test_failure' | 'git_anomaly' | 'opportunity';

export interface ProactiveInsight {
  id: string;
  type: InsightType;
  summary: string;
  detail: string;
  suggested_action: string;
  created_at: number;
  seen: boolean;
  project_cwd: string;
}

export class ProactiveSurface {
  private timers: ReturnType<typeof setInterval>[] = [];
  private lastKnownHead: string = '';
  private lastPollAt: number = 0;
  private insights: ProactiveInsight[] = [];

  constructor(
    private graph: KnowledgeGraph,
    private eventBus: IEventBus,
    private cwd: string,
  ) {
    this.lastKnownHead = this.getGitHead();
  }

  start(intervalMs = 30_000): void {
    const timer = setInterval(() => this.poll().catch(() => {}), intervalMs);
    if (typeof timer === 'object' && 'unref' in timer) (timer as NodeJS.Timeout).unref();
    this.timers.push(timer);
    // Initial poll after 10s
    const init = setTimeout(() => this.poll().catch(() => {}), 10_000);
    if (typeof init === 'object' && 'unref' in init) (init as NodeJS.Timeout).unref();
    this.timers.push(init as unknown as ReturnType<typeof setInterval>);
  }

  stop(): void {
    this.timers.forEach(t => clearInterval(t));
    this.timers = [];
  }

  getUnseen(): ProactiveInsight[] {
    return this.insights.filter(i => !i.seen);
  }

  markSeen(id: string): void {
    const insight = this.insights.find(i => i.id === id);
    if (insight) insight.seen = true;
  }

  getAll(): ProactiveInsight[] { return [...this.insights]; }

  private async poll(): Promise<void> {
    if (!existsSync(resolve(this.cwd, '.git'))) return; // not a git repo

    const newInsights: ProactiveInsight[] = [];

    // Check git activity
    const gitInsight = this.checkGitActivity();
    if (gitInsight) newInsights.push(gitInsight);

    // Check test failures
    const testInsight = this.checkTestFailures();
    if (testInsight) newInsights.push(testInsight);

    this.lastPollAt = Date.now();

    for (const insight of newInsights) {
      this.insights.push(insight);
      // Keep last 50 insights
      if (this.insights.length > 50) this.insights.shift();

      // Store as SIGNAL node in graph
      this.storeInsightNode(insight);

      // Emit WS event
      this.eventBus.emit({ type: 'agent.insight', insight } as Record<string, unknown>);
    }
  }

  private checkGitActivity(): ProactiveInsight | null {
    try {
      const currentHead = this.getGitHead();
      if (!currentHead || currentHead === this.lastKnownHead) return null;

      const log = execSync(
        `git log ${this.lastKnownHead}..${currentHead} --oneline --stat`,
        { cwd: this.cwd, timeout: 3000, encoding: 'utf8' }
      ).trim();

      this.lastKnownHead = currentHead;
      if (!log) return null;

      const lines = log.split('\n');
      const commitCount = lines.filter(l => /^[a-f0-9]{7,}/.test(l)).length;

      return this.makeInsight('opportunity',
        `${commitCount} new commit${commitCount > 1 ? 's' : ''} since last session`,
        log.slice(0, 500),
        'Run /review to review the changes'
      );
    } catch { return null; }
  }

  private checkTestFailures(): ProactiveInsight | null {
    // Look for JUnit XML or vitest output files with failures
    const outputPaths = [
      join(this.cwd, 'test-results'),
      join(this.cwd, '.vitest'),
      join(this.cwd, 'coverage'),
    ];

    for (const dir of outputPaths) {
      try {
        if (!existsSync(dir)) continue;
        const xmlFiles = readdirSafe(dir).filter(f => f.endsWith('.xml'));
        for (const xml of xmlFiles) {
          const path = join(dir, xml);
          const stat = statSync(path);
          if (stat.mtimeMs < this.lastPollAt) continue; // file older than last poll
          const content = readFileSync(path, 'utf8');
          const failures = [...content.matchAll(/<failure[^>]*message="([^"]+)"/g)].length;
          if (failures > 0) {
            return this.makeInsight('test_failure',
              `${failures} test failure${failures > 1 ? 's' : ''} detected`,
              `Found in ${xml}`,
              'Run /debug to investigate the failing tests'
            );
          }
        }
      } catch {}
    }
    return null;
  }

  private makeInsight(type: InsightType, summary: string, detail: string, suggestedAction: string): ProactiveInsight {
    return {
      id: crypto.randomUUID(),
      type,
      summary,
      detail,
      suggested_action: suggestedAction,
      created_at: Date.now(),
      seen: false,
      project_cwd: this.cwd,
    };
  }

  private storeInsightNode(insight: ProactiveInsight): void {
    try {
      const node = createNode({
        id: insight.id,
        graph_id: 'root',
        label: `[insight] ${insight.summary}`,
        type: NodeType.SIGNAL,
        metadata: { insight_type: insight.type, project_cwd: insight.project_cwd, is_proactive_insight: true },
        content: [{ id: crypto.randomUUID(), node_id: insight.id, type: ContentType.TEXT, data: insight.detail, metadata: {} }],
      });
      this.graph.addNode(node);
    } catch {} // non-fatal
  }

  private getGitHead(): string {
    try {
      return execSync('git rev-parse HEAD', { cwd: this.cwd, timeout: 1000, encoding: 'utf8' }).trim();
    } catch { return ''; }
  }
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir) as string[];
  } catch { return []; }
}
