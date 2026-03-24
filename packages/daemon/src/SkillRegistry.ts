import { readFileSync, readdirSync, existsSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import YAML from 'yaml';
import type { SkillDefinition } from '@0agent/core';

export class SkillRegistry {
  private skills: Map<string, SkillDefinition> = new Map();
  private builtinNames: Set<string> = new Set();
  private builtinDir: string;
  private customDir: string;

  constructor(opts?: { builtinDir?: string; customDir?: string }) {
    this.builtinDir = opts?.builtinDir ?? join(homedir(), '.0agent', 'skills', 'builtin');
    this.customDir = opts?.customDir ?? join(homedir(), '.0agent', 'skills', 'custom');
  }

  /**
   * Load all skills from builtin + custom directories.
   */
  async loadAll(): Promise<void> {
    this.skills.clear();
    this.builtinNames.clear();
    this.loadFromDir(this.builtinDir, true);
    this.loadFromDir(this.customDir, false);
  }

  private loadFromDir(dir: string, isBuiltin: boolean): void {
    if (!existsSync(dir)) return;
    const files = readdirSync(dir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
    for (const file of files) {
      try {
        const raw = readFileSync(join(dir, file), 'utf8');
        const skill = YAML.parse(raw) as SkillDefinition;
        if (skill.name) {
          this.skills.set(skill.name, skill);
          if (isBuiltin) this.builtinNames.add(skill.name);
        }
      } catch (err) {
        console.warn(`Failed to load skill ${file}: ${err}`);
      }
    }
  }

  /**
   * Reload all skills (after create/delete).
   */
  async reload(): Promise<void> {
    await this.loadAll();
  }

  get(name: string): SkillDefinition | undefined {
    const normalized = name.replace(/^\//, '');
    return this.skills.get(normalized);
  }

  list(): SkillDefinition[] {
    return [...this.skills.values()];
  }

  isBuiltin(name: string): boolean {
    return this.builtinNames.has(name);
  }

  /**
   * Create a custom skill. Returns the SkillDefinition.
   * Throws if name conflicts with built-in.
   */
  createCustom(name: string, yamlContent: string): SkillDefinition {
    if (this.builtinNames.has(name)) {
      throw new Error(`Cannot override built-in skill: ${name}`);
    }
    mkdirSync(this.customDir, { recursive: true });
    const filePath = join(this.customDir, `${name}.yaml`);
    writeFileSync(filePath, yamlContent, 'utf8');
    const skill = YAML.parse(yamlContent) as SkillDefinition;
    this.skills.set(name, skill);
    return skill;
  }

  /**
   * Remove a custom skill. Throws if built-in.
   */
  removeCustom(name: string): void {
    if (this.builtinNames.has(name)) {
      throw new Error(`Cannot delete built-in skill: ${name}`);
    }
    const filePath = join(this.customDir, `${name}.yaml`);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
    this.skills.delete(name);
  }

  get size(): number {
    return this.skills.size;
  }
}
