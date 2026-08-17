export const PACKAGE_NAME = '@joy-media/agent-tools' as const;

export type {
  ToolDefinition,
  ToolScope,
  ToolCapability,
  Precondition,
  CostEstimate,
  ToolResult,
  ToolDiff,
  JsonSchema,
  JsonValue,
} from './types.js';

export type {
  EditorContext,
  ProjectSummary,
  SelectionContext,
  TimelineContext,
  CompositionSummary,
  CaptionContext,
  AudioContext,
  ProviderContext,
  ProviderSummary,
  ExportTargetContext,
  ContextOptions,
  CommandDispatcher,
  CommandDispatchResult,
} from './context.js';
export { buildEditorContext } from './context.js';

export type { QueryTool } from './queries.js';
export {
  createFindClipTool,
  createFindActiveClipsTool,
  createSearchTranscriptTool,
  createGetAudioRegionsTool,
  createInspectPropertiesTool,
  createFindMissingAssetsTool,
  createEstimateImpactTool,
  createGetTimelineSummaryTool,
  createGetProviderCapabilitiesTool,
  createGetBrandConstraintsTool,
} from './queries.js';

export type { EditTool } from './edit-tools.js';
export {
  createInsertClipTool,
  createRemoveClipTool,
  createMoveClipTool,
  createTrimClipTool,
  createSplitClipTool,
  createJoinClipsTool,
  createSetGainTool,
  createSetPanTool,
  createSetMuteTool,
  createSetFadeTool,
  createAddEffectTool,
} from './edit-tools.js';

export type { ToolRegistry } from './registry.js';
export { createToolRegistry } from './registry.js';

export type {
  AgentEditPlan,
  AgentPlanStep,
  PlanEstimate,
  MoneyRange,
  DurationRange,
  Money,
  PlanStatus,
  ApprovalRequest,
  ApprovalReason,
  PrivacyImpact,
  PlanOptions,
} from './plan.js';
export { createPlan, validatePlan, addStepToPlan, updatePlanStatus } from './plan.js';

export type { AgentExecutionMode, ApprovalPolicy, ApprovalDecision } from './approval.js';
export {
  ALL_TOOL_CAPABILITIES,
  ApprovalEngine,
  createSuggestOnlyApprovalPolicy,
  createPreviewAndApprovePolicy,
  createAutoApplyLowRiskPolicy,
  createFullAutoWithinLimitsPolicy,
  createDefaultApprovalPolicy,
  createPermissiveApprovalPolicy,
  createStrictApprovalPolicy,
} from './approval.js';

export type { PlanEstimation } from './estimation.js';
export { estimatePlan, estimateStep, isPlanLocalOnly } from './estimation.js';

export type { PlanValidationResult, PlanError } from './plan-validation.js';
export {
  validatePlanStructure,
  validatePlanAgainstContext,
  validateStepDependencies,
} from './plan-validation.js';

export type { DryRunResult, DryRunStepResult, AggregateDiff } from './dry-run.js';
export { dryRunPlan } from './dry-run.js';

export type { ExecutionResult, ExecutionStepResult, ExecutionOptions } from './execution.js';
export { PlanExecutor, createDefaultExecutionOptions } from './execution.js';

export type { IdempotencyRecord, IdempotencyTracker } from './idempotency.js';
export { IdempotencyStore, createIdempotencyStore } from './idempotency.js';

export {
  generateTransactionLabel,
  generateStepLabel,
  formatTransactionLabel,
} from './transaction-naming.js';

export type { ExecutionOrder } from './execution-order.js';
export { resolveExecutionOrder, canStepExecute, getReadySteps } from './execution-order.js';

export type { VerificationResult, VerificationCheck } from './verification.js';
export {
  verifyAgentRun,
  verifyEntitiesExist,
  verifyNoInvalidOverlaps,
  verifyGeneratedAssetsDecode,
  verifyCaptionsWithinBounds,
  verifyAudioNotClipped,
  verifyNoMissingAssets,
  verifyUserIntentChecks,
} from './verification.js';

export type {
  AgentActor,
  AgentCommandEnvelope,
  EnvelopeOptions,
  EnvelopeValidation,
  ProjectRevisionId,
} from './envelope.js';
export {
  AGENT_COMMAND_SCHEMA_VERSION,
  createEnvelope,
  validateEnvelope,
  checkBaseRevision,
  RevisionConflictError,
} from './envelope.js';

export type {
  ShortenIntroRequest,
  ShortenIntroResult,
  ShortenIntroAnalysis,
} from './shorten-intro.js';
export { analyseShortenIntro } from './shorten-intro.js';

export type {
  AgentPropertyAnimationOperation,
  PropertyAnimationOperationValidation,
} from './property-animation-operations.js';
export { validatePropertyAnimationOperation } from './property-animation-operations.js';

export type {
  SpecialistScope,
  SpecialistContext,
  SpecialistDefinition,
  SpecialistBudget,
  SpecialistRunOptions,
  SpecialistRunResult,
  ChangeSetProposal,
  ProposedEdit,
  ProposalDomain,
  ProposalConflict,
  CombinedChangeSet,
  CombinedApprovalGrant,
  CommitCombinedOptions,
  CommitCombinedResult,
  DeniedSpecialist,
  FailedSpecialist,
} from './specialists.js';
export {
  runSpecialists,
  combineProposals,
  commitCombinedChangeSet,
  DEFAULT_SPECIALIST_BUDGET,
} from './specialists.js';
export {
  BUILT_IN_SPECIALISTS,
  CAPTION_AGENT,
  AUDIO_CLEANUP_AGENT,
  COLOR_REVIEW_AGENT,
  PACING_AGENT,
} from './specialists-builtin.js';

export type {
  AtomicApprovalGrant,
  AtomicRunOptions,
  AtomicRunResult,
  AtomicStepOutcome,
} from './atomic.js';
export { runPlanAtomically } from './atomic.js';

export type {
  AgentJobRequestTemplate,
  AsyncAgentRunOptions,
  AsyncAgentJobOutcome,
  AsyncAgentRunResult,
} from './async-jobs.js';
export { runPlanWithAsyncJobs } from './async-jobs.js';
export type { MaskAgentJobInput } from './masking-jobs.js';
export { createMaskAgentJobRequest } from './masking-jobs.js';

export type { AgentBranch, BranchComparison } from './branch.js';
export { BranchManager, createBranchManager } from './branch.js';

export type { RevertResult } from './revert.js';
export { revertAgentRun, findAgentTransactions, canRevertAgentRun } from './revert.js';

export type { AuditEntry, AuditAction } from './audit.js';
export { AuditTrail, createAuditTrail } from './audit.js';

export type { AgentMemory, AgentPreference } from './memory.js';
export { AgentMemoryManager, createAgentMemoryManager } from './memory.js';

export type { KiloCodeHostOptions } from './kilocode-host.js';
export { KILOCODE_AGENT_HOST_ID, createKiloCodeAgentHostManifest } from './kilocode-host.js';

export type {
  BenchmarkIntent,
  ValidationCheck,
  BenchmarkProject,
  BenchmarkMetrics,
  BenchmarkSuiteResult,
  PolicyLeakTestResult,
  PolicyViolation,
  EvaluationReport,
} from './benchmarks/index.js';

export {
  BENCHMARK_INTENTS,
  BENCHMARK_PROJECTS,
  BenchmarkRunner,
  createBenchmarkRunner,
  runLocalOnlyPolicyLeakTest,
  generateEvaluationReport,
  meetsBaseline,
  BASELINE_THRESHOLDS,
} from './benchmarks/index.js';

export type {
  CreativeBriefScope,
  DestinationPreset,
  InferenceConfidence,
  RecommendationRisk,
  RecommendationKind,
  RecommendationId,
  CreativeEvidenceRefV1,
  AssumptionV1,
  CapabilityGapV1,
  HumanDecisionV1,
  CreativeRecommendationV1,
  CreativeBriefRequestV1,
  InterpretedGoalV1,
  FactInferenceDistinctionV1,
  CreativeBriefV1,
  CreativeBriefInputV1,
  CreativeBriefOptions,
  BriefRequestValidationResult,
  BriefValidationResult,
} from './creative-brief.js';
export {
  DEFAULT_DETERMINISTIC_CLOCK,
  FORBIDDEN_PATTERNS,
  MAX_LENGTHS,
  RECOMMENDATION_KINDS,
  CREATIVE_BRIEF_SCOPES,
  DESTINATION_PRESETS,
  validateCreativeBriefRequest,
  validateCreativeBrief,
  containsForbiddenPattern,
  deepCheckForbiddenPatterns,
  createCreativeBrief,
  createCreativeBriefInput,
  verifyPersianPreservation,
  containsPersian,
} from './creative-brief.js';

export type {
  CreativeModelAdapter,
  ModelAdapterInputV1,
  ModelAdapterOutputV1,
} from './model-adapter.js';
export {
  isModelAdapterInputV1,
  isModelAdapterOutputV1,
} from './model-adapter.js';
