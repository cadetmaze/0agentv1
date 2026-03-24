import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { NodeType } from '@0agent/core';
import { RESOURCE_DEFAULTS } from './ResourceDefaults.js';

// ─── Interfaces ────────────────────────────────────────

export interface GraphReadScope {
  mode: 'none' | 'entities' | 'context' | 'full_readonly';
  entity_ids: string[];
  context_types: string[];  // NodeType values as strings
  max_depth: number;
}

export interface SandboxConfig {
  type: 'firecracker' | 'docker' | 'podman' | 'bwrap' | 'cloud' | 'process';
  network_access: 'none' | 'allowlist' | 'full';
  network_allowlist?: string[];
  filesystem_access: 'none' | 'readonly' | 'scoped';
  filesystem_scope?: string;
  has_browser: boolean;
  has_display: boolean;
}

export interface CapabilityToken {
  id: string;
  subagent_id: string;
  parent_session_id: string;
  issued_at: number;
  expires_at: number;
  trust_level: 1 | 2;
  allowed_tools: string[];
  blocked_tools: string[];
  graph_read: GraphReadScope;
  graph_write: false;
  allowed_credentials: string[];
  max_duration_ms: number;
  max_llm_calls: number;
  max_llm_tokens: number;
  max_tool_calls: number;
  sandbox: SandboxConfig;
  signature: string;
}

export type TaskType = 'web_research' | 'code_execution' | 'browser_task' | 'file_editing' | 'send_message';

export interface TokenIssueRequest {
  subagent_id: string;
  parent_session_id: string;
  task_type: TaskType;
  graph_read_scope?: Partial<GraphReadScope>;
  extra_tools?: string[];
  override_duration_ms?: number;
  sandbox_overrides?: Partial<SandboxConfig>;
}

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

// ─── Fixed-order canonical field keys ──────────────────

const CANONICAL_FIELDS: ReadonlyArray<keyof Omit<CapabilityToken, 'signature'>> = [
  'id',
  'subagent_id',
  'parent_session_id',
  'issued_at',
  'expires_at',
  'trust_level',
  'allowed_tools',
  'blocked_tools',
  'graph_read',
  'graph_write',
  'allowed_credentials',
  'max_duration_ms',
  'max_llm_calls',
  'max_llm_tokens',
  'max_tool_calls',
  'sandbox',
];

// ─── Signing helpers ───────────────────────────────────

/**
 * Produce a deterministic JSON serialization of all token fields except `signature`,
 * in the fixed order defined by CANONICAL_FIELDS.
 */
function canonicalize(token: CapabilityToken): string {
  const ordered: Record<string, unknown> = {};
  for (const key of CANONICAL_FIELDS) {
    ordered[key] = token[key];
  }
  return JSON.stringify(ordered);
}

/**
 * Sign a token by computing HMAC-SHA256 over the canonical JSON.
 * Returns the hex-encoded signature string.
 */
export function signToken(token: CapabilityToken, secret: string): string {
  const canonical = canonicalize(token);
  return createHmac('sha256', secret).update(canonical).digest('hex');
}

/**
 * Validate a capability token:
 *  1. Check expiry
 *  2. Verify HMAC signature with timing-safe comparison
 *  3. Assert graph_write === false
 */
export function validateToken(token: CapabilityToken, secret: string): ValidationResult {
  // 1. Expiry check
  if (Date.now() > token.expires_at) {
    return { valid: false, reason: 'Token has expired' };
  }

  // 2. HMAC verification (timing-safe)
  const expected = signToken(token, secret);
  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf = Buffer.from(token.signature, 'hex');

  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    return { valid: false, reason: 'Invalid signature' };
  }

  // 3. graph_write must be false
  if (token.graph_write !== false) {
    return { valid: false, reason: 'graph_write must be false' };
  }

  return { valid: true };
}

// ─── Token issuance ────────────────────────────────────

/**
 * Build a capability token from a TokenIssueRequest, applying resource defaults
 * for the given task type, then sign it.
 */
export function issueToken(req: TokenIssueRequest, secret: string): CapabilityToken {
  const defaults = RESOURCE_DEFAULTS[req.task_type];
  const now = Date.now();
  const durationMs = req.override_duration_ms ?? defaults.max_duration_ms;

  const graphRead: GraphReadScope = {
    mode: req.graph_read_scope?.mode ?? 'none',
    entity_ids: req.graph_read_scope?.entity_ids ?? [],
    context_types: req.graph_read_scope?.context_types ?? [],
    max_depth: req.graph_read_scope?.max_depth ?? 1,
  };

  const sandbox: SandboxConfig = {
    type: req.sandbox_overrides?.type ?? 'docker',
    network_access: req.sandbox_overrides?.network_access ?? defaults.network_access,
    filesystem_access: req.sandbox_overrides?.filesystem_access ?? defaults.filesystem_access,
    has_browser: req.sandbox_overrides?.has_browser ?? (defaults.has_browser ?? false),
    has_display: req.sandbox_overrides?.has_display ?? (defaults.has_display ?? false),
    ...(req.sandbox_overrides?.network_allowlist != null
      ? { network_allowlist: req.sandbox_overrides.network_allowlist }
      : {}),
    ...(req.sandbox_overrides?.filesystem_scope != null
      ? { filesystem_scope: req.sandbox_overrides.filesystem_scope }
      : {}),
  };

  const allowedTools = [
    ...defaults.allowed_tools,
    ...(req.extra_tools ?? []),
  ];

  const token: CapabilityToken = {
    id: randomUUID(),
    subagent_id: req.subagent_id,
    parent_session_id: req.parent_session_id,
    issued_at: now,
    expires_at: now + durationMs,
    trust_level: 1,
    allowed_tools: allowedTools,
    blocked_tools: [],
    graph_read: graphRead,
    graph_write: false,
    allowed_credentials: [],
    max_duration_ms: durationMs,
    max_llm_calls: defaults.max_llm_calls,
    max_llm_tokens: defaults.max_llm_tokens,
    max_tool_calls: defaults.max_tool_calls,
    sandbox,
    signature: '',
  };

  token.signature = signToken(token, secret);
  return token;
}
