/** P07 WP-07.1 — checkpointed workflow runtime: retry, cancel, resume, idempotent reuse (§23.5). */
/** P07 WP-07.2 adds §23.6 human-in-the-loop parking: `waiting_for_input` without held resources. */

import type { JoyWorkflow, RetryPolicy, WorkflowNode } from './definition.js';
import { upstreamOf, validateWorkflow } from './definition.js';
import { computeRunKey } from './run-key.js';

export type NodeRunState =
  'pending' | 'succeeded' | 'failed' | 'skipped' | 'canceled' | 'waiting_for_input';

export type WorkflowRunState =
  'succeeded' | 'failed' | 'canceled' | 'waiting_for_manual_intervention' | 'waiting_for_input';

export const CHECKPOINT_VERSION = 1 as const;

/** §23.6: the requests an approval node may make of a human reviewer. */
export type HumanInputRequestKind =
  | 'choose-candidates'
  | 'confirm-cost'
  | 'allow-remote-upload'
  | 'approve-transcript'
  | 'approve-voice-identity'
  | 'accept-edit-diff'
  | 'select-variant'
  | 'approve-render';

export const HUMAN_INPUT_REQUEST_KINDS: readonly HumanInputRequestKind[] = [
  'choose-candidates',
  'confirm-cost',
  'allow-remote-upload',
  'approve-transcript',
  'approve-voice-identity',
  'accept-edit-diff',
  'select-variant',
  'approve-render',
];

/** JSON-serializable description of what a parked node is waiting for (§23.6). */
export interface HumanInputRequest {
  readonly kind: HumanInputRequestKind;
  readonly prompt: string;
  /** Review payload (candidates, cost estimate, diff…). Must be JSON-serializable. */
  readonly payload?: unknown;
}

export interface NodeCheckpoint {
  readonly runKey: string;
  readonly state: NodeRunState;
  readonly attempts: number;
  readonly deterministic: boolean;
  readonly output?: unknown;
  readonly failureCode?: string;
  /** Present while the node is parked as `waiting_for_input` (§23.6). */
  readonly pendingRequest?: HumanInputRequest;
  /** The human response a succeeded node consumed; keeps the decision authoritative on resume. */
  readonly resolvedInput?: unknown;
}

/** Serializable run snapshot; resuming from it never duplicates completed work (§23.5). */
export interface RunCheckpoint {
  readonly checkpointVersion: typeof CHECKPOINT_VERSION;
  readonly runId: string;
  readonly workflowId: string;
  readonly workflowVersion: string;
  readonly projectRevision: string;
  readonly state: WorkflowRunState;
  readonly nodes: Readonly<Record<string, NodeCheckpoint>>;
}

export interface NodeExecutionContext {
  readonly node: WorkflowNode;
  /** Outputs of upstream nodes keyed by node id; source nodes also receive workflow inputs. */
  readonly upstream: Readonly<Record<string, unknown>>;
  readonly workflowInputs: unknown;
  readonly attempt: number;
  readonly runKey: string;
  /** Identity of the enclosing run; lets composite nodes (map/batch) derive child run ids. */
  readonly runId: string;
  readonly projectRevision: string;
  /** §23.6: the human response provided for this node, when one has been supplied. */
  readonly humanInput?: unknown;
}

export type NodeResult =
  | { readonly ok: true; readonly output: unknown }
  | { readonly ok: false; readonly failureCode: string; readonly retryable: boolean }
  /** §23.6: park the node (and its dependents) until a human responds; holds no resources. */
  | { readonly waiting: true; readonly request: HumanInputRequest };

export type NodeHandler = (context: NodeExecutionContext) => NodeResult;

export class WorkflowEngineError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'WorkflowEngineError';
    this.code = code;
  }
}

export interface ExecuteWorkflowOptions {
  readonly workflow: JoyWorkflow;
  readonly runId: string;
  readonly projectRevision: string;
  readonly workflowInputs: unknown;
  /** Handlers keyed by node type (e.g. `analysis.transcribe`). */
  readonly handlers: Readonly<Record<string, NodeHandler>>;
  /** Resume from a prior checkpoint instead of starting fresh. */
  readonly resumeFrom?: RunCheckpoint;
  /** §23.5: nondeterministic outputs are reused on resume only when policy says so. */
  readonly reuseNondeterministic?: boolean;
  /** Cooperative cancellation, checked before each node starts. */
  readonly shouldCancel?: () => boolean;
  /** §23.6: human responses keyed by node id; supplied when resuming a parked run. */
  readonly humanInputs?: Readonly<Record<string, unknown>>;
}

export interface ExecuteWorkflowResult {
  readonly checkpoint: RunCheckpoint;
  /** Node ids whose handler actually ran in this call. */
  readonly executedNodeIds: readonly string[];
  /** Node ids restored from the resume checkpoint without re-running work. */
  readonly reusedNodeIds: readonly string[];
}

interface MutableNodeRecord {
  runKey: string;
  state: NodeRunState;
  attempts: number;
  deterministic: boolean;
  output?: unknown;
  failureCode?: string;
  pendingRequest?: HumanInputRequest;
  resolvedInput?: unknown;
}

function effectiveRetry(workflow: JoyWorkflow, node: WorkflowNode): RetryPolicy {
  return node.retry ?? workflow.policy.defaultRetry;
}

function toCheckpointNodes(
  records: ReadonlyMap<string, MutableNodeRecord>,
): Record<string, NodeCheckpoint> {
  const nodes: Record<string, NodeCheckpoint> = {};
  for (const [id, record] of records) {
    const entry: {
      runKey: string;
      state: NodeRunState;
      attempts: number;
      deterministic: boolean;
      output?: unknown;
      failureCode?: string;
      pendingRequest?: HumanInputRequest;
      resolvedInput?: unknown;
    } = {
      runKey: record.runKey,
      state: record.state,
      attempts: record.attempts,
      deterministic: record.deterministic,
    };
    if (record.state === 'succeeded') {
      entry.output = record.output;
    }
    if (record.failureCode !== undefined) {
      entry.failureCode = record.failureCode;
    }
    if (record.pendingRequest !== undefined) {
      entry.pendingRequest = record.pendingRequest;
    }
    if (record.resolvedInput !== undefined) {
      entry.resolvedInput = record.resolvedInput;
    }
    nodes[id] = entry;
  }
  return nodes;
}

function transitiveDependents(
  workflow: JoyWorkflow,
  from: string,
  upstream: ReadonlyMap<string, readonly string[]>,
): Set<string> {
  const dependents = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of workflow.nodes) {
      if (dependents.has(node.id) || node.id === from) {
        continue;
      }
      const parents = upstream.get(node.id) ?? [];
      if (parents.some((parent) => parent === from || dependents.has(parent))) {
        dependents.add(node.id);
        changed = true;
      }
    }
  }
  return dependents;
}

/**
 * Synchronous, deterministic execution of a validated workflow DAG.
 *
 * - Nodes run in the deterministic topological order from `validateWorkflow`.
 * - Failed retryable attempts repeat up to the effective retry policy's maxAttempts.
 * - `shouldCancel` parks the run as `canceled`; finished nodes keep their results.
 * - Resuming reuses checkpointed successes whose recomputed run key still matches —
 *   deterministic nodes always, nondeterministic only with `reuseNondeterministic`.
 * - Failure policy: `stop` skips dependents and fails; `continue-independent` keeps
 *   independent branches running; `manual` parks as `waiting_for_manual_intervention`.
 * - §23.6: a `waiting` node result parks that node (and its dependents) as
 *   `waiting_for_input`; independent branches keep executing, and the call returns —
 *   no Worker resources are held while the human decides. Resume with `humanInputs`
 *   re-runs only the parked node; a succeeded node that consumed a human response is
 *   reused on later resumes (the recorded decision is authoritative) unless a new
 *   response for it is supplied or its run key changed.
 */
export function executeWorkflow(options: ExecuteWorkflowOptions): ExecuteWorkflowResult {
  const { workflow, resumeFrom } = options;
  const validation = validateWorkflow(workflow);
  if (!validation.ok) {
    const first = validation.issues[0];
    throw new WorkflowEngineError(
      'workflow/invalid-definition',
      `workflow failed validation: ${first ? `${first.code} — ${first.message}` : 'unknown issue'}`,
    );
  }
  if (resumeFrom !== undefined) {
    if (resumeFrom.checkpointVersion !== CHECKPOINT_VERSION) {
      throw new WorkflowEngineError(
        'workflow/unsupported-checkpoint-version',
        `checkpoint version ${String(resumeFrom.checkpointVersion)} is not supported`,
      );
    }
    if (
      resumeFrom.workflowId !== workflow.id ||
      resumeFrom.workflowVersion !== workflow.version ||
      resumeFrom.projectRevision !== options.projectRevision
    ) {
      throw new WorkflowEngineError(
        'workflow/checkpoint-mismatch',
        'checkpoint belongs to a different workflow id/version or project revision',
      );
    }
  }

  const nodesById = new Map(workflow.nodes.map((node) => [node.id, node]));
  const upstream = upstreamOf(workflow);
  const records = new Map<string, MutableNodeRecord>();
  const executedNodeIds: string[] = [];
  const reusedNodeIds: string[] = [];

  let runState: WorkflowRunState = 'succeeded';
  const blocked = new Set<string>();
  /** Dependents of parked §23.6 nodes: they stay pending, but independent branches run. */
  const waitingBlocked = new Set<string>();

  for (const nodeId of validation.order) {
    const node = nodesById.get(nodeId) as WorkflowNode;
    const parents = upstream.get(nodeId) ?? [];
    const providedInput = options.humanInputs?.[nodeId];

    // Upstream slots are null (never undefined) when a parent has not produced output,
    // so run keys stay canonicalizable and checkpoints stay JSON-round-trippable.
    const upstreamOutputs: Record<string, unknown> = {};
    for (const parent of parents) {
      upstreamOutputs[parent] = records.get(parent)?.output ?? null;
    }
    const runKey = computeRunKey({
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      nodeId: node.id,
      nodeType: node.type,
      params: node.params,
      normalizedInputs: parents.length === 0 ? options.workflowInputs : upstreamOutputs,
      projectRevision: options.projectRevision,
    });

    if (runState !== 'succeeded' || blocked.has(nodeId) || waitingBlocked.has(nodeId)) {
      records.set(nodeId, {
        runKey,
        state: blocked.has(nodeId) ? 'skipped' : 'pending',
        attempts: 0,
        deterministic: node.deterministic,
      });
      continue;
    }

    if (options.shouldCancel?.() === true) {
      runState = 'canceled';
      records.set(nodeId, {
        runKey,
        state: 'pending',
        attempts: 0,
        deterministic: node.deterministic,
      });
      continue;
    }

    const prior = resumeFrom?.nodes[nodeId];
    // §23.6: a recorded human decision stays authoritative across resumes unless a new
    // response for the node is supplied in this call (or its run key changed).
    const humanResolved = prior?.resolvedInput !== undefined && providedInput === undefined;
    const reusable =
      prior !== undefined &&
      prior.state === 'succeeded' &&
      prior.runKey === runKey &&
      (node.deterministic || options.reuseNondeterministic === true || humanResolved);
    if (reusable) {
      const record: MutableNodeRecord = {
        runKey,
        state: 'succeeded',
        attempts: prior.attempts,
        deterministic: node.deterministic,
        output: prior.output,
      };
      if (prior.resolvedInput !== undefined) {
        record.resolvedInput = prior.resolvedInput;
      }
      records.set(nodeId, record);
      reusedNodeIds.push(nodeId);
      continue;
    }

    const handler = options.handlers[node.type];
    if (handler === undefined) {
      throw new WorkflowEngineError(
        'workflow/missing-handler',
        `no handler registered for node type "${node.type}" (node "${node.id}")`,
      );
    }

    const retry = effectiveRetry(workflow, node);
    let attempts = 0;
    let final: NodeResult | undefined;
    while (attempts < retry.maxAttempts) {
      attempts += 1;
      final = handler({
        node,
        upstream: upstreamOutputs,
        workflowInputs: options.workflowInputs,
        attempt: attempts,
        runKey,
        runId: options.runId,
        projectRevision: options.projectRevision,
        humanInput: providedInput,
      });
      if ('waiting' in final || final.ok || !final.retryable) {
        break;
      }
    }
    executedNodeIds.push(nodeId);

    if (final !== undefined && 'waiting' in final) {
      // §23.6: park the node; independent branches keep running and the call returns,
      // so no Worker resources are consumed while the human decides.
      records.set(nodeId, {
        runKey,
        state: 'waiting_for_input',
        attempts,
        deterministic: node.deterministic,
        pendingRequest: final.request,
      });
      for (const dependent of transitiveDependents(workflow, nodeId, upstream)) {
        waitingBlocked.add(dependent);
      }
      continue;
    }

    if (final !== undefined && final.ok) {
      const record: MutableNodeRecord = {
        runKey,
        state: 'succeeded',
        attempts,
        deterministic: node.deterministic,
        output: final.output === undefined ? null : final.output,
      };
      if (providedInput !== undefined) {
        record.resolvedInput = providedInput;
      }
      records.set(nodeId, record);
      continue;
    }

    records.set(nodeId, {
      runKey,
      state: 'failed',
      attempts,
      deterministic: node.deterministic,
      failureCode: final === undefined ? 'workflow/no-attempt' : final.failureCode,
    });
    for (const dependent of transitiveDependents(workflow, nodeId, upstream)) {
      blocked.add(dependent);
    }
    if (workflow.policy.failure === 'manual') {
      runState = 'waiting_for_manual_intervention';
    } else if (workflow.policy.failure === 'stop') {
      runState = 'failed';
    }
    // continue-independent: runState stays 'succeeded' so independent branches keep
    // executing; the post-pass below reports the overall run as failed.
  }

  // A continue-independent run that saw any failure reports failed overall; a run with
  // no failure but a parked §23.6 node reports waiting_for_input.
  let sawFailure = false;
  let sawWaiting = false;
  for (const record of records.values()) {
    if (record.state === 'failed') {
      sawFailure = true;
    }
    if (record.state === 'waiting_for_input') {
      sawWaiting = true;
    }
  }
  if (runState === 'succeeded' && sawFailure) {
    runState = 'failed';
  } else if (runState === 'succeeded' && sawWaiting) {
    runState = 'waiting_for_input';
  }

  const checkpoint: RunCheckpoint = {
    checkpointVersion: CHECKPOINT_VERSION,
    runId: options.runId,
    workflowId: workflow.id,
    workflowVersion: workflow.version,
    projectRevision: options.projectRevision,
    state: runState,
    nodes: toCheckpointNodes(records),
  };
  return { checkpoint, executedNodeIds, reusedNodeIds };
}
