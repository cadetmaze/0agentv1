import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir, hostname } from 'node:os';
import YAML from 'yaml';
import type { KnowledgeGraph } from '@0agent/core';
import { NodeType, createNode } from '@0agent/core';

export interface UserIdentity {
  id: string;                // "usr_abc123" — permanent UUID, never changes
  name: string;              // "Sahil Godara"
  entity_node_id: string;   // node ID in personal graph
  device_id: string;        // "macOS-Hostname"
  timezone: string;         // "Asia/Kolkata"
  preferred_surface: 'terminal' | 'slack' | 'api';
  created_at: number;
}

const IDENTITY_PATH = resolve(homedir(), '.0agent', 'identity.yaml');
const DEFAULT_IDENTITY: Omit<UserIdentity, 'id' | 'entity_node_id' | 'created_at'> = {
  name: 'User',
  device_id: `unknown-device`,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
  preferred_surface: 'terminal',
};

export class IdentityManager {
  private identity: UserIdentity | null = null;

  constructor(private graph: KnowledgeGraph) {}

  /**
   * Load or create identity. Call once at daemon startup.
   */
  async init(): Promise<UserIdentity> {
    if (existsSync(IDENTITY_PATH)) {
      const raw = readFileSync(IDENTITY_PATH, 'utf8');
      this.identity = YAML.parse(raw) as UserIdentity;
    } else {
      // First run — create default identity
      this.identity = {
        ...DEFAULT_IDENTITY,
        id: crypto.randomUUID(),
        entity_node_id: crypto.randomUUID(),
        created_at: Date.now(),
        device_id: `${process.platform}-${hostname()}`,
      };
      this.save();
    }

    // Ensure entity node exists in graph
    const existing = this.graph.getNode(this.identity.entity_node_id);
    if (!existing) {
      this.graph.addNode(createNode({
        id: this.identity.entity_node_id,
        graph_id: 'root',
        label: this.identity.name,
        type: NodeType.ENTITY,
        metadata: {
          is_user: true,
          device_id: this.identity.device_id,
          timezone: this.identity.timezone,
        },
      }));
    }

    return this.identity;
  }

  get(): UserIdentity | null { return this.identity; }

  update(updates: Partial<Pick<UserIdentity, 'name' | 'timezone' | 'preferred_surface'>>): void {
    if (!this.identity) return;
    Object.assign(this.identity, updates);
    this.save();
    // Update entity node label if name changed
    if (updates.name) {
      this.graph.updateNode(this.identity.entity_node_id, { label: updates.name });
    }
  }

  /**
   * Build an identity context string to inject into every session system prompt.
   */
  buildContext(): string {
    if (!this.identity) return '';
    const lines = [`You are talking to ${this.identity.name}.`];
    if (this.identity.timezone && this.identity.timezone !== 'UTC') {
      lines.push(`Their timezone: ${this.identity.timezone}.`);
    }
    return lines.join(' ');
  }

  private save(): void {
    const dir = dirname(IDENTITY_PATH);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(IDENTITY_PATH, YAML.stringify(this.identity), 'utf8');
  }
}
