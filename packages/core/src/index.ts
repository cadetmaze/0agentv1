// ─── Graph Types ────────────────────────────────────
export {
  NodeType,
  ContentType,
  type NodeContent,
  type GraphNode,
  createNode,
} from './graph/GraphNode.js';

export {
  EdgeType,
  type GraphEdge,
  createEdge,
} from './graph/GraphEdge.js';

export { SubGraph } from './graph/SubGraph.js';

export {
  GraphQuery,
  type QueryResult,
  type StructuralQueryOpts,
  type SemanticQueryOpts,
  type MergedQueryOpts,
} from './graph/GraphQuery.js';

export { KnowledgeGraph } from './graph/KnowledgeGraph.js';

// ─── Storage ────────────────────────────────────────
export {
  SQLiteAdapter,
  type SQLiteAdapterOptions,
  type WeightEvent,
  type TraceRecord,
  type AliasRecord,
} from './storage/adapters/SQLiteAdapter.js';

export { TraceStore } from './storage/TraceStore.js';
export { WeightEventLog } from './storage/WeightEventLog.js';
export { ObjectStore } from './storage/ObjectStore.js';

// ─── Engine ─────────────────────────────────────────
export {
  WeightPropagation,
  type StepLedger,
  type OutcomeSignal,
  type PropagationResult,
  type PropagationConfig,
} from './engine/WeightPropagation.js';

export {
  DecayScheduler,
  type DecayConfig,
  type DecayReport,
} from './engine/DecayScheduler.js';

export {
  SelectionPolicy,
  type SelectionConfig,
  type SelectionResult,
} from './engine/SelectionPolicy.js';

export {
  InferenceEngine,
  type IInferenceEngine,
  type InferencePlan,
  type InferenceRequest,
  type InferenceResult,
  type ResolvedEntity,
  type SelectedEdge,
} from './engine/InferenceEngine.js';

export {
  CreditAttribution,
  type DAGNode,
  type AttributionConfig,
} from './engine/CreditAttribution.js';

export { WorkflowSuggestionEngine } from './engine/WorkflowSuggestionEngine.js';

// ─── Trace ──────────────────────────────────────────
export {
  type OutcomeTrace,
  type AttributionResult,
} from './trace/OutcomeTrace.js';

export {
  TraversalLedger,
  type TraversalEntry,
} from './trace/TraversalLedger.js';

export {
  DeferredTraceStore,
  type DeferredTraceEntry,
  type RetroOutput,
  type RetroStep,
} from './trace/DeferredTrace.js';

export { TraceReplay, type ReplayResult } from './trace/TraceReplay.js';

export { SkillTraceDecorator } from './trace/SkillTraceDecorator.js';

// ─── Entity Resolution (Phase 4) ───────────────────
export {
  EntityResolutionPipeline,
  type IEntityExtractor,
  type ExtractionResult,
  type PipelineResult,
} from './entity/EntityResolutionPipeline.js';

export {
  ContextActivator,
  type ActivationConfig,
  type ActivationScore,
} from './entity/ContextActivator.js';

export { MCPEnrichedResolver } from './entity/MCPEnrichedResolver.js';

// ─── Memory ─────────────────────────────────────────
export { WorkingMemory, type WorkingMemoryConfig } from './memory/WorkingMemory.js';
export { BlinkingMemory, type SessionSummary } from './memory/BlinkingMemory.js';
export { ArchivalMemory, type ArchivalEntry } from './memory/ArchivalMemory.js';

// ─── Concurrency ────────────────────────────────────
export { EdgeWeightUpdater } from './concurrency/EdgeWeightUpdater.js';

// ─── Embedding ──────────────────────────────────────
export { type EmbeddingAdapter } from './embedding/adapters/OllamaAdapter.js';
export { OllamaAdapter } from './embedding/adapters/OllamaAdapter.js';
export { NomicAdapter } from './embedding/adapters/NomicAdapter.js';
export { OpenAIAdapter } from './embedding/adapters/OpenAIAdapter.js';
export { HNSWIndex, type HNSWSearchResult, type HNSWConfig } from './embedding/HNSWIndex.js';
export { MultimodalEmbedder } from './embedding/MultimodalEmbedder.js';

// ─── Entity Resolution ─────────────────────────────
export { AliasIndex } from './entity/AliasIndex.js';

// ─── Entity Nesting (personality + hierarchy) ──────
export {
  PersonalityProfileStore,
  type PersonalityProfile,
  PERSONALITY_NODE_LABEL,
} from './entity/PersonalityProfile.js';

export {
  EntityHierarchy,
  type EntityContext,
  type VisibilityPolicy,
  DEFAULT_VISIBILITY_POLICY,
} from './entity/EntityHierarchy.js';

export {
  PersonalityAccumulator,
  type InteractionSignal,
} from './entity/PersonalityAccumulator.js';
export {
  NodeResolutionService,
  type ResolutionResult,
  type ResolutionConfig,
} from './entity/NodeResolutionService.js';

// ─── Bootstrap ──────────────────────────────────────
export {
  StagedMutationStore,
  type StagedMutation,
} from './bootstrap/StagedMutations.js';

export {
  HypothesisManager,
  type HypothesisRecord,
} from './bootstrap/HypothesisManager.js';

export {
  GraphConstructor,
  type ILLMClient,
  type BootstrapProposal,
} from './bootstrap/GraphConstructor.js';

export { BootstrapProtocol } from './bootstrap/BootstrapProtocol.js';

// ─── Types ──────────────────────────────────────────
export {
  type SkillDefinition,
  type SkillCategory,
  type SkillArg,
  type SkillSubagentProfile,
  type SkillGraphScope,
  type SkillSandboxConfig,
  type SkillWorkflow,
  type SkillOutput,
  type SkillOutcome,
  type SkillVerifier,
} from './types/SkillDefinition.js';

export {
  type ImprovementPlan,
  type SelfImprovementConfig,
  type AutoApplyPolicy,
  type SkillGap,
  type WorkflowChange,
  type GraphHealth,
  type ToolUtilization,
  type SkillRefinement,
  type PriorityAction,
  type ImprovementRecord,
  DEFAULT_SELF_IMPROVEMENT_CONFIG,
} from './types/SelfImprovement.js';

export { SelfImprovementEngine } from './engine/SelfImprovementEngine.js';
export { SELF_IMPROVEMENT_PROMPT } from './engine/SelfImprovementPrompt.js';

// ─── Maintenance (Phase 5) ─────────────────────────
export {
  EdgePruner,
  type PruneConfig,
  type PruneResult,
} from './maintenance/EdgePruner.js';

export {
  NodeDeduplicator,
  type DeduplicationConfig,
  type MergeCandidate,
  type DeduplicationResult,
} from './maintenance/NodeDeduplicator.js';

export {
  SubgraphArchiver,
  type ArchivalConfig,
  type ArchivalResult,
} from './maintenance/SubgraphArchiver.js';

export {
  CompactionOrchestrator,
  type CompactionSchedule,
} from './maintenance/CompactionOrchestrator.js';

export {
  GraphCheckpointManager,
  type Checkpoint,
  type CheckpointSnapshot,
} from './maintenance/GraphCheckpoint.js';

export {
  GraphRollback,
  type RollbackMode,
  type RollbackResult,
} from './maintenance/GraphRollback.js';

// ─── Concurrency (Phase 5) ─────────────────────────
export {
  SessionSnapshotManager,
  type SnapshotEntry,
  type SessionSnapshotData,
  type MergeResult,
} from './concurrency/SessionSnapshot.js';
