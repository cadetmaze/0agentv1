/**
 * SkillTraceDecorator — Decorates OutcomeTrace with skill execution metadata.
 *
 * Used when a skill invocation creates or resolves a trace, attaching
 * the skill name and optional sprint period for /retro aggregation.
 */

import type { OutcomeTrace } from './OutcomeTrace.js';

export class SkillTraceDecorator {
  /**
   * Decorate a trace with skill execution metadata.
   * Called when a skill invocation creates a trace.
   */
  static decorate(
    trace: OutcomeTrace,
    skillName: string,
    sprintPeriod?: string,
  ): OutcomeTrace {
    return {
      ...trace,
      metadata: {
        ...trace.metadata,
        skill_name: skillName,
        ...(sprintPeriod ? { sprint_period: sprintPeriod } : {}),
      },
    };
  }

  /**
   * Check if a trace was created by a specific skill.
   * If skillName is provided, checks for exact match.
   * If omitted, returns true for any skill-tagged trace.
   */
  static isSkillTrace(trace: OutcomeTrace, skillName?: string): boolean {
    if (!trace.metadata?.skill_name) return false;
    if (skillName) return trace.metadata.skill_name === skillName;
    return true;
  }

  /**
   * Get the skill name from a trace, if present.
   */
  static getSkillName(trace: OutcomeTrace): string | null {
    return (trace.metadata?.skill_name as string) ?? null;
  }
}
