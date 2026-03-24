import type { LLMExecutor } from './LLMExecutor.js';
import { AgentExecutor, type AgentExecutorConfig } from './AgentExecutor.js';
import { ExecutionVerifier, type VerificationResult, type AgentResult } from './ExecutionVerifier.js';
import { isRuntimeBug } from './RuntimeSelfHeal.js';
import type { RuntimeSelfHeal } from './RuntimeSelfHeal.js';

export interface HealAttempt {
  attempt_number: number;
  error_context: string;
  result: AgentResult;
  verification: VerificationResult;
}

export interface HealResult extends AgentResult {
  heal_attempts: HealAttempt[];
  healed: boolean;  // true if a retry succeeded
}

export class SelfHealLoop {
  private verifier: ExecutionVerifier;

  constructor(
    private llm: LLMExecutor,
    private config: AgentExecutorConfig,
    private onStep: (step: string) => void,
    private onToken: (token: string) => void,
    private maxAttempts: number = 3,
    private runtimeHealer?: RuntimeSelfHeal,
  ) {
    this.verifier = new ExecutionVerifier(config.cwd);
  }

  async executeWithHealing(task: string, systemContext?: string, signal?: AbortSignal): Promise<HealResult> {
    const attempts: HealAttempt[] = [];
    let currentContext = systemContext;
    let finalResult: AgentResult | null = null;
    let lastVerification: VerificationResult = { success: true, method: 'none', details: '', retryable: false, elapsed_ms: 0 };

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      if (signal?.aborted) break;
      // First attempt: no special step. Retries: emit heal_attempt step.
      if (attempt > 1) {
        this.onStep(`↺ Self-healing (attempt ${attempt}/${this.maxAttempts}): ${lastVerification.details}`);
      }

      const executor = new AgentExecutor(this.llm, this.config, this.onStep, this.onToken);
      const result = await executor.execute(task, currentContext, signal);
      finalResult = result;

      // Verify
      lastVerification = await this.verifier.verify(result);

      attempts.push({ attempt_number: attempt, error_context: currentContext ?? '', result, verification: lastVerification });

      if (lastVerification.success) {
        // Emit verification success step
        this.onStep(`✓ Verified: ${lastVerification.details}`);
        return { ...result, heal_attempts: attempts, healed: attempt > 1 };
      }

      // If not retryable or last attempt, break
      if (!lastVerification.retryable || attempt === this.maxAttempts) break;

      // Build enriched context for next attempt
      currentContext = this.buildHealContext(attempt, lastVerification, result, systemContext);
    }

    // All attempts exhausted or not retryable
    if (!lastVerification.success) {
      this.onStep(`⚠ Verification: ${lastVerification.details}`);
    }

    // Check if the final error looks like a runtime code bug — offer self-heal
    const lastError = finalResult?.output ?? '';
    if (this.runtimeHealer && isRuntimeBug(lastError)) {
      this.onStep('🔧 This looks like a runtime code bug — analyzing for self-fix...');
      this.runtimeHealer.analyze(lastError, 'session task').then(proposal => {
        if (proposal) {
          this.onStep(`🔧 Fix proposed for ${proposal.location.relPath}:${proposal.location.line} — awaiting your approval in terminal`);
          this.runtimeHealer!.emitProposal(proposal);
        }
      }).catch(() => {});
    }

    return { ...finalResult!, heal_attempts: attempts, healed: false };
  }

  private buildHealContext(attempt: number, verification: VerificationResult, result: AgentResult, originalContext?: string): string {
    const errorBlock = [
      `--- PREVIOUS ATTEMPT FAILED (attempt ${attempt} of ${this.maxAttempts}) ---`,
      `Verification method: ${verification.method}`,
      `Failure: ${verification.details}`,
      `Commands that ran: ${result.commands_run.slice(-5).join(', ') || 'none'}`,
      `Files written: ${result.files_written.join(', ') || 'none'}`,
      `Last output (excerpt): ${result.output.slice(-600)}`,
      ``,
      `Fix: ${this.getSuggestion(verification)}`,
      `--- END FAILURE CONTEXT ---`,
    ].join('\n');

    return [originalContext, errorBlock].filter(Boolean).join('\n\n');
  }

  private getSuggestion(v: VerificationResult): string {
    if (v.method === 'http_check') return 'Check for port conflicts. Try a different port or add error handling to the server start command.';
    if (v.method === 'test_run') return 'Fix the failing tests before proceeding.';
    if (v.method === 'file_exists') return 'Ensure the file write command actually succeeded and the path is correct.';
    return 'Try a different approach.';
  }
}
