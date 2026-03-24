// ─── Types ──────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

// ─── TokenValidator ─────────────────────────────────

/**
 * Validates a capability token inside the sandbox.
 *
 * Note: the sandbox does NOT have access to the daemon secret, so HMAC
 * verification is not possible here. The parent orchestrator already
 * validated the signature before injecting the token.
 *
 * This validator checks structural integrity and expiry only.
 */
export class TokenValidator {
  validate(token: Record<string, unknown>): ValidationResult {
    if (!token.id || !token.subagent_id) {
      return { valid: false, reason: 'missing_fields' };
    }

    if (typeof token.expires_at !== 'number') {
      return { valid: false, reason: 'invalid_expiry' };
    }

    if (Date.now() > (token.expires_at as number)) {
      return { valid: false, reason: 'expired' };
    }

    if (token.graph_write !== false) {
      return { valid: false, reason: 'graph_write_not_false' };
    }

    return { valid: true };
  }
}
