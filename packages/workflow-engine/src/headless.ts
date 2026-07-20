/** P07 WP-07.3 — headless workflow execution: bind inputs, run, emit outputs (§7.4). */

import type { AuthoringIssue } from './authoring.js';
import { parseWorkflowJson, validateAgainstSchema } from './authoring.js';
import type { NodeRegistry } from './nodes.js';
import type { RunDashboard } from './operations.js';
import { RunRecorder, buildRunDashboard, instrumentHandlers } from './operations.js';
import type {
  ExecuteWorkflowResult,
  NodeHandler,
  RunCheckpoint,
  WorkflowRunState,
} from './runtime.js';
import { WorkflowEngineError, executeWorkflow } from './runtime.js';

export interface HeadlessRunOptions {
  /** Raw workflow definition JSON; validated via `parseWorkflowJson`. */
  readonly workflowJson: string;
  /** Run inputs; validated against the workflow's `inputs` schema before execution. */
  readonly inputs: unknown;
  /** Handlers keyed by node type (e.g. a `buildNodeLibrary().handlers`). */
  readonly handlers: Readonly<Record<string, NodeHandler>>;
  /** Registry for §23.7 node-level validation of the authored JSON, when available. */
  readonly registry?: NodeRegistry;
  readonly runId: string;
  readonly projectRevision: string;
  /** Raw checkpoint JSON from a prior run; resuming never duplicates completed work. */
  readonly resumeFromJson?: string;
  /** §23.6 human responses keyed by node id, supplied when resuming a parked run. */
  readonly humanInputs?: Readonly<Record<string, unknown>>;
  readonly reuseNondeterministic?: boolean;
  readonly shouldCancel?: () => boolean;
}

export type HeadlessRunResult =
  | { readonly ok: false; readonly issues: readonly AuthoringIssue[] }
  | {
      readonly ok: true;
      readonly state: WorkflowRunState;
      readonly checkpoint: RunCheckpoint;
      /** Outputs of succeeded `output`-category nodes (or terminal nodes when none exist). */
      readonly outputs: Readonly<Record<string, unknown>>;
      /** Violations of the workflow's `outputs` schema for a succeeded run. */
      readonly outputIssues: readonly AuthoringIssue[];
      readonly dashboard: RunDashboard;
    };

function parseCheckpointJson(
  raw: string,
):
  | { readonly ok: true; readonly checkpoint: RunCheckpoint }
  | { readonly ok: false; readonly issue: AuthoringIssue } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      issue: {
        code: 'headless/invalid-checkpoint',
        message: `checkpoint is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      issue: { code: 'headless/invalid-checkpoint', message: 'checkpoint must be a JSON object' },
    };
  }
  // Version and workflow/revision identity are enforced by `executeWorkflow`.
  return { ok: true, checkpoint: parsed as RunCheckpoint };
}

/**
 * §7.4 headless/automation entry point: loads a workflow definition, binds and
 * validates run inputs against the declared schema, executes (or resumes) it,
 * and returns the checkpoint, collected outputs, and per-node dashboard. Uses
 * the same schemas and runtime contracts as the editor; no UI involved. Pure
 * over its inputs — file/process I/O lives in the `joy-workflow` bin wrapper.
 */
export function runWorkflowHeadless(options: HeadlessRunOptions): HeadlessRunResult {
  const parsed = parseWorkflowJson(
    options.workflowJson,
    options.registry === undefined ? {} : { registry: options.registry },
  );
  if (!parsed.ok) {
    return parsed;
  }
  const { workflow } = parsed;

  const inputIssues: AuthoringIssue[] = validateAgainstSchema(
    workflow.inputs,
    options.inputs,
    '$',
  ).map((issue) => ({
    code: 'headless/invalid-inputs',
    message: issue.message,
    path: issue.path,
  }));
  if (inputIssues.length > 0) {
    return { ok: false, issues: inputIssues };
  }

  let resumeFrom: RunCheckpoint | undefined;
  if (options.resumeFromJson !== undefined) {
    const checkpointResult = parseCheckpointJson(options.resumeFromJson);
    if (!checkpointResult.ok) {
      return { ok: false, issues: [checkpointResult.issue] };
    }
    resumeFrom = checkpointResult.checkpoint;
  }

  const recorder = new RunRecorder();
  let result: ExecuteWorkflowResult;
  try {
    result = executeWorkflow({
      workflow,
      runId: options.runId,
      projectRevision: options.projectRevision,
      workflowInputs: options.inputs,
      handlers: instrumentHandlers(options.handlers, recorder),
      ...(resumeFrom === undefined ? {} : { resumeFrom }),
      ...(options.reuseNondeterministic === undefined
        ? {}
        : { reuseNondeterministic: options.reuseNondeterministic }),
      ...(options.shouldCancel === undefined ? {} : { shouldCancel: options.shouldCancel }),
      ...(options.humanInputs === undefined ? {} : { humanInputs: options.humanInputs }),
    });
  } catch (error) {
    if (error instanceof WorkflowEngineError) {
      return { ok: false, issues: [{ code: error.code, message: error.message }] };
    }
    throw error;
  }

  // Outputs: succeeded `output`-category nodes are the workflow's products;
  // workflows without output nodes fall back to terminal (no-downstream) nodes.
  const outputNodeIds = workflow.nodes
    .filter((node) => node.category === 'output')
    .map((node) => node.id);
  const terminalNodeIds = workflow.nodes
    .filter((node) => !workflow.edges.some((edge) => edge.from === node.id))
    .map((node) => node.id);
  const productNodeIds = outputNodeIds.length > 0 ? outputNodeIds : terminalNodeIds;
  const outputs: Record<string, unknown> = {};
  for (const nodeId of productNodeIds) {
    const record = result.checkpoint.nodes[nodeId];
    if (record !== undefined && record.state === 'succeeded') {
      outputs[nodeId] = record.output;
    }
  }

  const outputIssues: AuthoringIssue[] =
    result.checkpoint.state === 'succeeded'
      ? validateAgainstSchema(workflow.outputs, outputs, '$').map((issue) => ({
          code: 'headless/invalid-outputs',
          message: issue.message,
          path: issue.path,
        }))
      : [];

  return {
    ok: true,
    state: result.checkpoint.state,
    checkpoint: result.checkpoint,
    outputs,
    outputIssues,
    dashboard: buildRunDashboard({ workflow, result, recorder }),
  };
}
