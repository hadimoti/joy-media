/** @joy-media/workflow-engine — deterministic workflow automation (P07, §23). */

export {
  WORKFLOW_FORMAT_VERSION,
  WORKFLOW_NODE_CATEGORIES,
  validateWorkflow,
  upstreamOf,
} from './definition.js';
export type {
  JoyWorkflow,
  RetryPolicy,
  WorkflowEdge,
  WorkflowFailureMode,
  WorkflowIssue,
  WorkflowIssueCode,
  WorkflowNode,
  WorkflowNodeCategory,
  WorkflowPermission,
  WorkflowValidation,
} from './definition.js';

export { CanonicalJsonError, canonicalJson, computeRunKey } from './run-key.js';
export type { RunKeyInput } from './run-key.js';

export {
  CHECKPOINT_VERSION,
  HUMAN_INPUT_REQUEST_KINDS,
  WORKFLOW_RUN_STATES,
  WorkflowEngineError,
  executeWorkflow,
  isWorkflowRunStateParked,
} from './runtime.js';
export type {
  ExecuteWorkflowOptions,
  ExecuteWorkflowResult,
  HumanInputRequest,
  HumanInputRequestKind,
  NodeCheckpoint,
  NodeExecutionContext,
  NodeHandler,
  NodeResult,
  NodeRunState,
  RunCheckpoint,
  WorkflowRunState,
} from './runtime.js';

// WP-07.2 — node library v1
export { NodeRegistry, NodeRegistryError } from './nodes.js';
export type {
  CreateNodeOptions,
  NodeLibraryIssue,
  NodeLibraryIssueCode,
  NodeParamIssue,
  NodeParamValidator,
  WorkflowNodeSpec,
} from './nodes.js';

export {
  InMemoryMapStateStore,
  NodeLibraryError,
  buildNodeLibrary,
  evaluateCondition,
  isValueRef,
  isWorkflowCondition,
  resolveValueRef,
} from './library.js';
export type {
  AnalysisPorts,
  BuildNodeLibraryOptions,
  EditorPorts,
  GenerationPorts,
  MapStateStore,
  NodeLibrary,
  NodeLibraryPorts,
  OutputPorts,
  RenderPorts,
  TransformPorts,
  ValueRef,
  WorkflowCondition,
} from './library.js';

export { MAP_BATCH_VERSION, runMapBatch } from './map.js';
export type { MapBatchState, MapItemRecord, RunMapBatchOptions, RunMapBatchResult } from './map.js';

// WP-07.3 — authoring + operations
export {
  SUPPORTED_SCHEMA_KEYWORDS,
  WorkflowAuthoringError,
  WorkflowBuilder,
  parseWorkflowJson,
  validateAgainstSchema,
  validateSchemaDeclaration,
  workflowToJson,
} from './authoring.js';
export type {
  AuthoringIssue,
  ParseWorkflowResult,
  SchemaIssue,
  WorkflowBuilderOptions,
} from './authoring.js';

export {
  RUN_ARTIFACT_KINDS,
  RunRecorder,
  boundRunArtifacts,
  boundRunLogEntries,
  buildRunDashboard,
  instrumentHandlers,
  isRunArtifactDeclaration,
  renderRunDashboardText,
} from './operations.js';
export type {
  BuildRunDashboardOptions,
  RunArtifact,
  RunArtifactDeclaration,
  RunArtifactKind,
  RunDashboard,
  RunDashboardNode,
  RunLogEntry,
  RunLogLevel,
} from './operations.js';

// Task 14 — durable production-run contracts and board projections.
export {
  InMemoryProductionRunStore,
  PRODUCTION_APPROVAL_VERSION,
  PRODUCTION_RUN_BOARD_SNAPSHOT_VERSION,
  PRODUCTION_RUN_EVENT_VERSION,
  PRODUCTION_RUN_RECORD_VERSION,
  appendProductionRunEvent,
  assertMonotonicProductionRunEvents,
  buildProductionRunBoardSnapshot,
  createProductionRunRecordFromDashboard,
  createQueuedProductionRunRecord,
  markProductionRunRunning,
  productionRunStateFromWorkflowRunState,
  recordProductionApprovalResponse,
} from './production-run.js';
export type {
  AppendProductionRunEventInput,
  CreateProductionRunRecordFromDashboardOptions,
  CreateQueuedProductionRunRecordOptions,
  ProductionApprovalStateV1,
  ProductionApprovalV1,
  ProductionRunAuthority,
  ProductionRunBoardApprovalV1,
  ProductionRunBoardRunV1,
  ProductionRunBoardSnapshotV1,
  ProductionRunCheckpointUpdateResultV1,
  ProductionRunCheckpointUpdateV1,
  ProductionRunDashboardLinksV1,
  ProductionRunEventTypeV1,
  ProductionRunEventV1,
  ProductionRunLinksV1,
  ProductionRunNodeProjectionV1,
  ProductionRunPublicLogEntryV1,
  ProductionRunRecordV1,
  ProductionRunStateV1,
  ProductionRunStore,
  RecordProductionApprovalResponseInput,
  RecordProductionApprovalResponseResult,
} from './production-run.js';

export { runWorkflowHeadless } from './headless.js';
export type { HeadlessRunOptions, HeadlessRunResult } from './headless.js';

// WP-07.4 — first-party workflows (§23.4)
export {
  FIRST_PARTY_WORKFLOWS_VERSION,
  FIRST_PARTY_WORKFLOW_IDS,
  buildFirstPartyWorkflows,
  buildLongVideoDraftReelsWorkflow,
  buildMultilingualPromoWorkflow,
  buildPodcastCleanupWorkflow,
  firstPartyDefinitionFiles,
} from './first-party.js';
export type { FirstPartyDefinitionFile, FirstPartyWorkflow } from './first-party.js';
