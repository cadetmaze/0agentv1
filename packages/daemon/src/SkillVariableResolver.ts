import { basename, join } from 'node:path';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import type { SkillDefinition } from '@0agent/core';

export interface ResolverContext {
  project_dir: string;
  project_name?: string;
  mentioned_entity_ids?: string[];
  args?: Record<string, string>;
  artifacts_dir?: string;
}

/**
 * Resolves template variables ($PROJECT_DIR, $CURRENT_PROJECT, etc.)
 * in skill YAML fields before execution.
 */
export class SkillVariableResolver {
  /**
   * Replace all known template variables in a single string.
   */
  resolve(template: string, ctx: ResolverContext): string {
    let result = template;

    // $PROJECT_DIR
    result = result.replace(/\$PROJECT_DIR/g, ctx.project_dir);

    // $CURRENT_PROJECT
    result = result.replace(
      /\$CURRENT_PROJECT/g,
      ctx.project_name ?? basename(ctx.project_dir),
    );

    // $MENTIONED_ENTITIES
    result = result.replace(
      /\$MENTIONED_ENTITIES/g,
      JSON.stringify(ctx.mentioned_entity_ids ?? []),
    );

    // $ARG_<KEY> — case-insensitive key lookup
    result = result.replace(/\$ARG_([A-Za-z0-9_]+)/g, (_match, key: string) => {
      if (!ctx.args) {
        console.warn(`Variable $ARG_${key} referenced but no args provided`);
        return _match;
      }
      const lower = key.toLowerCase();
      const entry = Object.entries(ctx.args).find(
        ([k]) => k.toLowerCase() === lower,
      );
      if (entry) return entry[1];
      console.warn(`Variable $ARG_${key} referenced but not found in args`);
      return _match;
    });

    // $LATEST_ARTIFACT:<type>
    result = result.replace(/\$LATEST_ARTIFACT:([A-Za-z0-9_-]+)/g, (_match, type: string) => {
      const artifactsBase = ctx.artifacts_dir ?? join(homedir(), '.0agent', 'artifacts');
      const typeDir = join(artifactsBase, type);
      if (!existsSync(typeDir)) {
        console.warn(`Artifact directory not found: ${typeDir}`);
        return _match;
      }
      try {
        const files = readdirSync(typeDir)
          .map(f => ({ name: f, mtime: statSync(join(typeDir, f)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime);
        if (files.length === 0) {
          console.warn(`No artifacts found in ${typeDir}`);
          return _match;
        }
        return join(typeDir, files[0].name);
      } catch (err) {
        console.warn(`Error scanning artifacts in ${typeDir}: ${err}`);
        return _match;
      }
    });

    return result;
  }

  /**
   * Deep-clone a SkillDefinition and resolve all template variables
   * in its string fields.
   */
  resolveSkill(skill: SkillDefinition, ctx: ResolverContext): SkillDefinition {
    const clone: SkillDefinition = JSON.parse(JSON.stringify(skill));

    // role_prompt
    clone.role_prompt = this.resolve(clone.role_prompt, ctx);

    // subagent.sandbox.filesystem_scope
    if (clone.subagent.sandbox.filesystem_scope) {
      clone.subagent.sandbox.filesystem_scope = this.resolve(
        clone.subagent.sandbox.filesystem_scope,
        ctx,
      );
    }

    // subagent.sandbox.network_allowlist
    if (clone.subagent.sandbox.network_allowlist) {
      clone.subagent.sandbox.network_allowlist = clone.subagent.sandbox.network_allowlist.map(
        (item) => this.resolve(item, ctx),
      );
    }

    // subagent.graph_scope.entity_ids
    if (clone.subagent.graph_scope.entity_ids) {
      clone.subagent.graph_scope.entity_ids = clone.subagent.graph_scope.entity_ids.map(
        (id) => this.resolve(id, ctx),
      );
    }

    // output.saves_to
    if (clone.output.saves_to) {
      clone.output.saves_to = this.resolve(clone.output.saves_to, ctx);
    }

    return clone;
  }
}
