/**
 * AnthropicSkillFetcher — fetches skill instructions from the Anthropic skills
 * repository at runtime and injects them as role_prompts for the agent.
 *
 * Anthropic's skills: https://github.com/anthropics/skills
 * Each is a SKILL.md with name/description frontmatter + Markdown instructions.
 *
 * Usage:
 *   const fetcher = new AnthropicSkillFetcher();
 *   const prompt = await fetcher.fetch('pdf');
 *   // → inject prompt into session as system context
 *
 * The agent then uses the skill instructions to guide its tool calls.
 * No adapter layer needed — the instructions tell the agent exactly what to do.
 */

const BASE_URL = 'https://raw.githubusercontent.com/anthropics/skills/main';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// Known skills in the Anthropic repo (as of 2026)
export const ANTHROPIC_SKILLS = [
  'algorithmic-art',
  'brand-guidelines',
  'canvas-design',
  'claude-api',
  'doc-coauthoring',
  'docx',
  'frontend-design',
  'internal-comms',
  'mcp-builder',
  'pdf',
  'pptx',
  'skill-creator',
  'slack-gif-creator',
  'theme-factory',
  'web-artifacts-builder',
  'webapp-testing',
  'xlsx',
] as const;

export type AnthropicSkillName = typeof ANTHROPIC_SKILLS[number];

interface CacheEntry {
  prompt: string;
  fetched_at: number;
}

export interface FetchedSkill {
  name: string;
  description: string;
  instructions: string;   // full Markdown body (the role_prompt)
  source_url: string;
  cached: boolean;
}

export class AnthropicSkillFetcher {
  private cache = new Map<string, CacheEntry>();

  /**
   * Fetch a skill's instructions from the Anthropic repo.
   * Returns the Markdown body as a role_prompt string.
   * Caches for 1 hour.
   */
  async fetch(skillName: string): Promise<FetchedSkill | null> {
    // Check cache
    const cached = this.cache.get(skillName);
    if (cached && Date.now() - cached.fetched_at < CACHE_TTL_MS) {
      return this.parseSkillMd(skillName, cached.prompt, true);
    }

    // Try primary path: skills/<name>/SKILL.md
    const urls = [
      `${BASE_URL}/skills/${skillName}/SKILL.md`,
      `${BASE_URL}/${skillName}/SKILL.md`,
      `${BASE_URL}/skills/${skillName}/README.md`,
    ];

    for (const url of urls) {
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': '0agent/1.0' },
          signal: AbortSignal.timeout(8_000),
        });

        if (res.ok) {
          const text = await res.text();
          this.cache.set(skillName, { prompt: text, fetched_at: Date.now() });
          return this.parseSkillMd(skillName, text, false);
        }
      } catch {}
    }

    return null;
  }

  /**
   * Parse a SKILL.md file into a FetchedSkill.
   * Extracts name/description from YAML frontmatter, instructions from body.
   */
  private parseSkillMd(skillName: string, raw: string, cached: boolean): FetchedSkill {
    let name = skillName;
    let description = '';
    let instructions = raw;

    // Extract YAML frontmatter (between --- ... ---)
    const frontmatterMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (frontmatterMatch) {
      const frontmatter = frontmatterMatch[1];
      instructions = frontmatterMatch[2].trim();

      // Extract name
      const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
      if (nameMatch) name = nameMatch[1].trim().replace(/["']/g, '');

      // Extract description
      const descMatch = frontmatter.match(/^description:\s*([\s\S]*?)(?=^\w|\Z)/m);
      if (descMatch) description = descMatch[1].replace(/\s+/g, ' ').trim().replace(/["']/g, '');
    }

    return {
      name,
      description,
      instructions,
      source_url: `https://github.com/anthropics/skills/tree/main/skills/${skillName}`,
      cached,
    };
  }

  /**
   * Build a system prompt that injects the Anthropic skill instructions.
   * This is what gets passed to the agent as context.
   */
  buildSystemPrompt(skill: FetchedSkill): string {
    return [
      `You are using the "${skill.name}" skill from Anthropic's skill library.`,
      ``,
      `Skill description: ${skill.description}`,
      ``,
      `Instructions:`,
      `---`,
      skill.instructions,
      `---`,
      ``,
      `Use the tools available to you (shell_exec, file_op, web_search, scrape_url, browser_open)`,
      `to complete the task following these instructions.`,
    ].join('\n');
  }

  /**
   * List all known Anthropic skills.
   */
  listAvailable(): string[] {
    return [...ANTHROPIC_SKILLS];
  }

  /**
   * Check if a skill name is a known Anthropic skill.
   */
  isAnthropicSkill(name: string): boolean {
    return (ANTHROPIC_SKILLS as readonly string[]).includes(name);
  }

  /**
   * Clear the cache (force re-fetch on next request).
   */
  clearCache(): void {
    this.cache.clear();
  }
}
