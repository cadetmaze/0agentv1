import type { SkillDefinition } from '@0agent/core';
import type { SubagentOrchestrator, SpawnRequest } from './SubagentOrchestrator.js';
import type { SubagentResult } from './SubagentResult.js';
import type { TaskType } from './CapabilityToken.js';

// ─── Interfaces ─────────────────────────────────────────

export interface SkillInvocation {
  skill: SkillDefinition;
  args: Record<string, string>;
  session_id: string;
}

export interface SkillOutput {
  format: 'prose' | 'json' | 'markdown' | 'diff';
  raw: string;
  parsed: unknown;
}

// ─── SkillInvoker ───────────────────────────────────────

export class SkillInvoker {
  constructor(private readonly orchestrator: SubagentOrchestrator) {}

  /**
   * Convert a SkillInvocation into a SpawnRequest and execute via the orchestrator.
   */
  async invoke(invocation: SkillInvocation): Promise<SkillOutput> {
    // 1. Map skill category to TaskType
    const taskType = this.inferTaskType(invocation.skill);

    // 2. Build SpawnRequest
    const req: SpawnRequest = {
      session_id: invocation.session_id,
      task: this.buildTaskPrompt(invocation.skill, invocation.args),
      task_type: taskType,
      system_prompt: invocation.skill.role_prompt,
      skill: invocation.skill,
    };

    // 3. Spawn subagent
    const result: SubagentResult = await this.orchestrator.spawn(req);

    // 4. Parse output into SkillOutput
    return this.parseOutput(
      result.output,
      invocation.skill.output?.format ?? 'prose',
    );
  }

  /**
   * Infer the TaskType from a SkillDefinition's subagent profile.
   */
  private inferTaskType(skill: SkillDefinition): TaskType {
    if (skill.subagent?.sandbox?.has_browser) return 'browser_task';
    if (skill.subagent?.tools?.includes('execute_command')) return 'code_execution';
    if (skill.subagent?.sandbox?.network_access === 'full') return 'web_research';
    if (skill.subagent?.tools?.some((t) => t.includes('write_file'))) return 'file_editing';
    return 'code_execution'; // default
  }

  /**
   * Build a task prompt string from a skill definition and runtime arguments.
   */
  private buildTaskPrompt(
    skill: SkillDefinition,
    args: Record<string, string>,
  ): string {
    let prompt = `Execute the "${skill.name}" skill.`;
    const entries = Object.entries(args);
    if (entries.length > 0) {
      prompt += '\n\nArguments:\n';
      for (const [k, v] of entries) {
        prompt += `- ${k}: ${v}\n`;
      }
    }
    return prompt;
  }

  /**
   * Parse raw output string into a typed SkillOutput.
   */
  private parseOutput(raw: string, format: SkillOutput['format']): SkillOutput {
    if (format === 'json') {
      try {
        return { format, raw, parsed: JSON.parse(raw) };
      } catch {
        return { format: 'prose', raw, parsed: raw };
      }
    }
    return { format, raw, parsed: raw };
  }
}
