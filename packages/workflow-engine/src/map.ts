/** P07 WP-07.2 — map/batch execution: one sub-workflow run per item, resumable per item (§23.2 control). */

import type { JoyWorkflow } from './definition.js';
import { validateWorkflow } from './definition.js';
import { computeRunKey } from './run-key.js';
import type { NodeHandler, RunCheckpoint, WorkflowRunState } from './runtime.js';
import { WorkflowEngineError, executeWorkflow } from './runtime.js';

export const MAP_BATCH_VERSION = 1 as const;

/** One processed batch item; JSON-round-trippable so batch progress survives resumes. */
export interface MapItemRecord {
  readonly index: number;
  /** Deterministic key over sub-workflow identity, project revision, index, and item content. */
  readonly itemKey: string;
  readonly state: WorkflowRunState;
  readonly checkpoint: RunCheckpoint;
  /** Outputs of the sub-workflow's sink nodes (no outgoing edges), present when succeeded. */
  readonly output?: Readonly<Record<string, unknown>>;
}

export interface MapBatchState {
  readonly batchVersion: typeof MAP_BATCH_VERSION;
  readonly items: readonly MapItemRecord[];
}

export interface RunMapBatchOptions {
  /** Sub-workflow applied once per item; each item becomes that run's workflow inputs. */
  readonly workflow: JoyWorkflow;
  readonly items: readonly unknown[];
  /** Parent run id; item runs derive `<runId>/item-<index>`. */
  readonly runId: string;
  readonly projectRevision: string;
  readonly handlers: Readonly<Record<string, NodeHandler>>;
  /** Prior batch state: matching completed items are reused, failed items resume (§23.5). */
  readonly priorState?: MapBatchState;
  readonly reuseNondeterministic?: boolean;
  /** Keep processing remaining items after an item fails (default: stop at first failure). */
  readonly continueOnItemFailure?: boolean;
  readonly shouldCancel?: () => boolean;
}

export interface RunMapBatchResult {
  readonly state: MapBatchState;
  readonly succeeded: boolean;
  readonly executedItemIndexes: readonly number[];
  readonly reusedItemIndexes: readonly number[];
  /** Per-item sink outputs in item order; null for items that did not succeed or never ran. */
  readonly outputs: readonly (Readonly<Record<string, unknown>> | null)[];
}

function itemKeyFor(
  workflow: JoyWorkflow,
  projectRevision: string,
  index: number,
  item: unknown,
): string {
  return computeRunKey({
    workflowId: workflow.id,
    workflowVersion: workflow.version,
    nodeId: `map-item-${String(index)}`,
    nodeType: 'control.map-item',
    params: null,
    normalizedInputs: item ?? null,
    projectRevision,
  });
}

function sinkNodeIds(workflow: JoyWorkflow): readonly string[] {
  const hasOutgoing = new Set(workflow.edges.map((edge) => edge.from));
  return workflow.nodes.filter((node) => !hasOutgoing.has(node.id)).map((node) => node.id);
}

function sinkOutputs(
  workflow: JoyWorkflow,
  checkpoint: RunCheckpoint,
): Readonly<Record<string, unknown>> {
  const outputs: Record<string, unknown> = {};
  for (const id of sinkNodeIds(workflow)) {
    outputs[id] = checkpoint.nodes[id]?.output ?? null;
  }
  return outputs;
}

/**
 * Runs `workflow` once per item, synchronously and in item order.
 *
 * - Each item gets a deterministic item key; a prior succeeded item with the same key is
 *   reused without executing anything (§23.5 — no duplicated completed work).
 * - A prior non-succeeded item with the same key resumes from its checkpoint, so only
 *   its unfinished nodes re-run.
 * - Changed item content (or sub-workflow version / project revision) changes the item
 *   key and re-runs that item only.
 * - The returned state is always complete for processed items, including failures, so
 *   callers can persist partial batch progress across parent-run resumes.
 * - §23.6 waits inside items are not supported in v1: a parked item is recorded and
 *   reported as a non-success (`workflow/map-item-waiting` at the node-library level).
 */
export function runMapBatch(options: RunMapBatchOptions): RunMapBatchResult {
  const validation = validateWorkflow(options.workflow);
  if (!validation.ok) {
    const first = validation.issues[0];
    throw new WorkflowEngineError(
      'workflow/map-invalid-subworkflow',
      `map sub-workflow failed validation: ${first ? `${first.code} — ${first.message}` : 'unknown issue'}`,
    );
  }

  const priorByKey = new Map<string, MapItemRecord>();
  for (const record of options.priorState?.items ?? []) {
    priorByKey.set(record.itemKey, record);
  }

  const records: MapItemRecord[] = [];
  const executedItemIndexes: number[] = [];
  const reusedItemIndexes: number[] = [];
  const outputs: (Readonly<Record<string, unknown>> | null)[] = options.items.map(() => null);
  let sawFailure = false;

  for (let index = 0; index < options.items.length; index += 1) {
    if (sawFailure && options.continueOnItemFailure !== true) {
      break;
    }
    if (options.shouldCancel?.() === true) {
      break;
    }
    const item = options.items[index];
    const itemKey = itemKeyFor(options.workflow, options.projectRevision, index, item);
    const prior = priorByKey.get(itemKey);

    if (prior !== undefined && prior.state === 'succeeded') {
      records.push(prior);
      reusedItemIndexes.push(index);
      outputs[index] = prior.output ?? {};
      continue;
    }

    const execution = executeWorkflow({
      workflow: options.workflow,
      runId: `${options.runId}/item-${String(index)}`,
      projectRevision: options.projectRevision,
      workflowInputs: item,
      handlers: options.handlers,
      ...(prior !== undefined ? { resumeFrom: prior.checkpoint } : {}),
      ...(options.reuseNondeterministic !== undefined
        ? { reuseNondeterministic: options.reuseNondeterministic }
        : {}),
    });
    executedItemIndexes.push(index);

    const state = execution.checkpoint.state;
    if (state === 'succeeded') {
      const output = sinkOutputs(options.workflow, execution.checkpoint);
      records.push({ index, itemKey, state, checkpoint: execution.checkpoint, output });
      outputs[index] = output;
    } else {
      records.push({ index, itemKey, state, checkpoint: execution.checkpoint });
      sawFailure = true;
    }
  }

  return {
    state: { batchVersion: MAP_BATCH_VERSION, items: records },
    succeeded: !sawFailure && records.length === options.items.length,
    executedItemIndexes,
    reusedItemIndexes,
    outputs,
  };
}
