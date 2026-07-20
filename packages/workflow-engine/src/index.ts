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
  WorkflowEngineError,
  executeWorkflow,
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

export { runWorkflowHeadless } from './headless.js';
export type { HeadlessRunOptions, HeadlessRunResult } from './headless.js';
