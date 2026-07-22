export const PACKAGE_NAME = '@joy-media/agent-tools' as const;

export type {
  ToolDefinition,
  ToolScope,
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

export type { ApprovalPolicy, ApprovalDecision } from './approval.js';
export {
  ApprovalEngine,
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

export type { IdempotencyRecord } from './idempotency.js';
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

export type { AgentBranch, BranchComparison } from './branch.js';
export { BranchManager, createBranchManager } from './branch.js';

export type { RevertResult } from './revert.js';
export { revertAgentRun, findAgentTransactions, canRevertAgentRun } from './revert.js';

export type { AuditEntry, AuditAction } from './audit.js';
export { AuditTrail, createAuditTrail } from './audit.js';

export type { AgentMemory, AgentPreference } from './memory.js';
export { AgentMemoryManager, createAgentMemoryManager } from './memory.js';

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
