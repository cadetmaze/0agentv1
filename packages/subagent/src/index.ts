// ─── Orchestrator ───────────────────────────────────
export {
  SubagentOrchestrator,
  type SpawnRequest,
  type OrchestratorConfig,
  type IEventBus,
} from './SubagentOrchestrator.js';

// ─── Skill Invoker ──────────────────────────────────
export {
  SkillInvoker,
  type SkillInvocation,
  type SkillOutput,
} from './SkillInvoker.js';

// ─── Skill Input Resolver ───────────────────────────
export {
  SkillInputResolver,
  type ResolverContext,
} from './SkillInputResolver.js';

// ─── Capability Token ───────────────────────────────
export {
  issueToken,
  signToken,
  validateToken,
  type CapabilityToken,
  type GraphReadScope,
  type SandboxConfig,
  type TaskType,
  type TokenIssueRequest,
  type ValidationResult,
} from './CapabilityToken.js';

// ─── Subagent Result ────────────────────────────────
export {
  type SubagentResult,
  type SubagentArtifact,
  type ToolCallRecord,
  errorResult,
} from './SubagentResult.js';

// ─── Watchdog ───────────────────────────────────────
export { Watchdog } from './Watchdog.js';

// ─── Resource Defaults ──────────────────────────────
export {
  RESOURCE_DEFAULTS,
  type ResourceConfig,
} from './ResourceDefaults.js';

// ─── Sandbox ────────────────────────────────────────
export {
  SandboxManager,
  type ISandboxBackend,
  type SandboxHandle,
  type SandboxCreateConfig,
} from './sandbox/SandboxManager.js';

export { DockerBackend } from './sandbox/DockerBackend.js';
export { ProcessBackend } from './sandbox/ProcessBackend.js';
export { PodmanBackend } from './sandbox/PodmanBackend.js';
export { BwrapBackend } from './sandbox/BwrapBackend.js';
export { FirecrackerBackend } from './sandbox/FirecrackerBackend.js';
export { CloudBackend } from './sandbox/CloudBackend.js';
