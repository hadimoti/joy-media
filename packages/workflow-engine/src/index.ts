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

export { CHECKPOINT_VERSION, WorkflowEngineError, executeWorkflow } from './runtime.js';
export type {
  ExecuteWorkflowOptions,
  ExecuteWorkflowResult,
  NodeCheckpoint,
  NodeExecutionContext,
  NodeHandler,
  NodeResult,
  NodeRunState,
  RunCheckpoint,
  WorkflowRunState,
} from './runtime.js';
