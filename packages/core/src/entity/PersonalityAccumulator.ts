import type { KnowledgeGraph } from '../graph/KnowledgeGraph.js';
import { PersonalityProfileStore, type PersonalityProfile } from './PersonalityProfile.js';
import { EntityHierarchy } from './EntityHierarchy.js';

export interface InteractionSignal {
  entity_id: string;
  session_id: string;
  input: string;               // what the person said
  output: string;              // what the agent responded
  skill_name?: string;         // which skill was used
  outcome_signal?: number;     // -1 to 1
  duration_ms: number;
  timestamp: number;
}

export class PersonalityAccumulator {
  private static readonly MAX_RAW_SIGNALS = 20;

  constructor(
    private graph: KnowledgeGraph,
    private profileStore: PersonalityProfileStore,
    private hierarchy: EntityHierarchy,
  ) {}

  /**
   * Process an interaction and update the entity's personality profile.
   * Also propagates an attenuated signal up to parent entities.
   */
  async accumulate(signal: InteractionSignal): Promise<PersonalityProfile> {
    // Get or create profile
    let profile = this.profileStore.get(signal.entity_id);
    if (!profile) {
      const entityNode = this.graph.getNode(signal.entity_id);
      profile = this.profileStore.createDefault(
        signal.entity_id,
        entityNode?.label ?? signal.entity_id,
      );
    }

    // Update interaction stats
    profile.interaction_count++;
    profile.last_interaction = signal.timestamp;

    // Append raw signal (keep last N)
    const rawSignal = this.buildRawSignal(signal);
    profile.raw_signals = [
      ...profile.raw_signals.slice(-(PersonalityAccumulator.MAX_RAW_SIGNALS - 1)),
      rawSignal,
    ];

    // Synthesize personality observations from recent signals
    this.synthesize(profile, signal);

    // Save updated profile
    this.profileStore.set(signal.entity_id, profile);

    // Propagate work-context signal to parent entities (company sees activity, not content)
    if (signal.skill_name) {
      this.hierarchy.propagateSignalUp(
        signal.entity_id,
        `used /${signal.skill_name}`,
        `Entity ran /${signal.skill_name} on: ${signal.input.slice(0, 80)}`,
        0.5,
      );
    }

    return profile;
  }

  /**
   * Build a raw signal string from an interaction.
   * Deliberately strips PII — only captures behavioral patterns.
   */
  private buildRawSignal(signal: InteractionSignal): string {
    const parts: string[] = [];
    if (signal.skill_name) parts.push(`skill:/${signal.skill_name}`);
    if (signal.outcome_signal !== undefined) {
      parts.push(`outcome:${signal.outcome_signal > 0 ? 'positive' : 'negative'}`);
    }
    // Input style signals (not content — just structure)
    const inputWords = signal.input.split(/\s+/).length;
    if (inputWords < 8) parts.push('style:terse');
    else if (inputWords > 40) parts.push('style:verbose');
    if (signal.input.includes('?')) parts.push('pattern:question');
    if (/^\s*[-•]/.test(signal.input)) parts.push('format:bullets');
    return `[${new Date(signal.timestamp).toISOString().slice(0, 10)}] ${parts.join(' ')}`;
  }

  /**
   * Synthesize personality traits from raw signals.
   * This is a simple heuristic — Phase 4's LLM could do this better.
   */
  private synthesize(profile: PersonalityProfile, latest: InteractionSignal): void {
    // Count style signals in last 10 interactions
    const recentSignals = profile.raw_signals.slice(-10);
    const terseCount = recentSignals.filter(s => s.includes('style:terse')).length;
    const verboseCount = recentSignals.filter(s => s.includes('style:verbose')).length;
    const bulletCount = recentSignals.filter(s => s.includes('format:bullets')).length;
    const questionCount = recentSignals.filter(s => s.includes('pattern:question')).length;

    // Update communication style
    const styleClues: string[] = [];
    if (terseCount > verboseCount) styleClues.push('terse');
    if (bulletCount > 2) styleClues.push('uses bullet points');
    if (questionCount > 3) styleClues.push('exploratory / asks questions');
    if (styleClues.length > 0) {
      profile.communication_style = styleClues.join(', ');
    }

    // Track which skills they use most
    if (
      latest.skill_name &&
      !profile.response_preferences.includes(`prefers:/${latest.skill_name}`)
    ) {
      const skillCount = profile.raw_signals.filter(
        s => s.includes(`skill:/${latest.skill_name}`),
      ).length;
      if (skillCount >= 3 && latest.skill_name) {
        profile.response_preferences = [
          ...profile.response_preferences.filter(p => !p.startsWith('prefers:/')),
          `prefers:/${latest.skill_name}`,
        ].slice(-5); // keep last 5 preferences
      }
    }
  }

  /**
   * Build a system prompt prefix for a session with this entity.
   * Injects personality context so responses match the person's style.
   */
  buildContextPrompt(entityId: string): string {
    const profile = this.profileStore.get(entityId);
    if (!profile || profile.interaction_count < 3) {
      return ''; // Not enough data yet — don't bias the response
    }

    const lines: string[] = [
      `You are talking to a person you know well (${profile.interaction_count} past interactions).`,
    ];

    if (profile.communication_style && !profile.communication_style.includes('unknown')) {
      lines.push(`Their communication style: ${profile.communication_style}.`);
    }
    if (profile.response_preferences.length > 0) {
      lines.push(`Their preferences: ${profile.response_preferences.join(', ')}.`);
    }
    if (profile.working_context) {
      lines.push(`Current context: ${profile.working_context}.`);
    }
    if (profile.timezone && profile.timezone !== 'UTC') {
      lines.push(`Their timezone: ${profile.timezone}.`);
    }

    lines.push("Match their style. Don't explain what you're doing. Just do it.");

    return lines.join('\n');
  }
}
