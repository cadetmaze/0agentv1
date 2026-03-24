import type { SkillDefinition } from '@0agent/core';

// ─── Interfaces ─────────────────────────────────────────

export interface ResolverContext {
  project_dir: string;
  project_name?: string;
  mentioned_entity_ids?: string[];
  args?: Record<string, string>;
  artifacts_dir?: string;
}

// ─── SkillInputResolver ─────────────────────────────────

/**
 * Resolves runtime template variables in skill definition fields.
 *
 * Supported variables:
 *   $PROJECT_DIR            — current project directory
 *   $CURRENT_PROJECT        — project name
 *   $MENTIONED_ENTITIES     — JSON array of entity IDs
 *   $ARG_<NAME>             — runtime argument by name (uppercased)
 *   $LATEST_ARTIFACT:<type> — most recent artifact of given type (stub)
 */
export class SkillInputResolver {
  /**
   * Resolve all template variables in a single string.
   */
  resolve(template: string, ctx: ResolverContext): string {
    let result = template;

    result = result.replace(/\$PROJECT_DIR/g, ctx.project_dir);
    result = result.replace(/\$CURRENT_PROJECT/g, ctx.project_name ?? '');

    if (ctx.mentioned_entity_ids) {
      result = result.replace(
        /\$MENTIONED_ENTITIES/g,
        JSON.stringify(ctx.mentioned_entity_ids),
      );
    }

    // $ARG_<name> resolution
    if (ctx.args) {
      for (const [key, val] of Object.entries(ctx.args)) {
        result = result.replace(
          new RegExp(`\\$ARG_${key.toUpperCase()}`, 'g'),
          val,
        );
      }
    }

    // $LATEST_ARTIFACT:<type> — stub: replace with empty string for now.
    // Full implementation requires filesystem access to scan artifacts_dir.
    const artifactPattern = /\$LATEST_ARTIFACT:(\w[\w-]*)/g;
    result = result.replace(artifactPattern, '');

    return result;
  }

  /**
   * Deep-clone a SkillDefinition and resolve all template variables in
   * its string fields.
   */
  resolveSkill(skill: SkillDefinition, ctx: ResolverContext): SkillDefinition {
    const clone = JSON.parse(JSON.stringify(skill)) as SkillDefinition;

    clone.role_prompt = this.resolve(clone.role_prompt, ctx);

    if (clone.output?.saves_to) {
      clone.output.saves_to = this.resolve(clone.output.saves_to, ctx);
    }

    if (clone.subagent?.sandbox?.filesystem_scope) {
      clone.subagent.sandbox.filesystem_scope = this.resolve(
        clone.subagent.sandbox.filesystem_scope,
        ctx,
      );
    }

    if (clone.subagent?.sandbox?.network_allowlist) {
      clone.subagent.sandbox.network_allowlist =
        clone.subagent.sandbox.network_allowlist.map((s: string) =>
          this.resolve(s, ctx),
        );
    }

    if (clone.subagent?.graph_scope?.entity_ids) {
      clone.subagent.graph_scope.entity_ids =
        clone.subagent.graph_scope.entity_ids.map((s: string) =>
          this.resolve(s, ctx),
        );
    }

    return clone;
  }
}
