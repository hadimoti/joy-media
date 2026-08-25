// apps/editor-web/src/workflow-runner.ts

import type { EditorSession } from './editor-session.js';
import {
  buildProductionRunBoardSnapshot,
  buildRunDashboard,
  computeRunKey,
  createProductionRunRecordFromDashboard,
  createQueuedProductionRunRecord,
  executeWorkflow,
  type HumanInputRequest,
  type JoyWorkflow,
  type NodeLibrary,
  type ProductionApprovalV1,
  type ProductionRunAuthority,
  type ProductionRunRecordV1,
  type ProductionRunStore,
  type RunCheckpoint,
  RunRecorder,
  instrumentHandlers,
  type WorkflowEdge,
  type WorkflowNode,
} from '@joy-media/workflow-engine';
import type { SpikeCommand } from '@joy-media/commands';
import { createAgentCommandBus } from './agent-command-bus.js';
import { loadWorkflow, resolveParameterizedValue } from './workflow-recorder.js';
import { getFirstPartyWorkflow } from './first-party-workflows.js';
import {
  createProductionFirstPartyLibrary,
  getProductionFirstPartyLibraryStatus,
  isProductionFirstPartyLibrary,
} from './first-party-handlers.js';

interface NodeRunResult {
  readonly nodeId: string;
  readonly success: boolean;
  readonly error?: string;
}

type CommandLike = { readonly tool: string; readonly arguments: unknown };

export interface ParkedWorkflowRun {
  readonly runId: string;
  readonly workflowId: string;
  readonly workflow: JoyWorkflow;
  readonly workflowInputs: unknown;
  readonly checkpoint: RunCheckpoint;
  readonly nodeId: string;
  readonly request: HumanInputRequest;
}

export type WorkflowRunOutcome =
  | {
      readonly status: 'succeeded';
      readonly workflowId: string;
      readonly runId: string;
      readonly outputs?: unknown;
    }
  | {
      readonly status: 'waiting_for_input';
      readonly workflowId: string;
      readonly runId: string;
      readonly nodeId: string;
      readonly request: HumanInputRequest;
      readonly checkpoint: RunCheckpoint;
      readonly approvalId?: string;
      readonly approvalRequestedSeq?: number;
      readonly approvalExpiresAtSeq?: number;
    }
  | {
      readonly status: 'failed';
      readonly workflowId: string;
      readonly runId: string;
      readonly error: string;
    };

export interface WorkflowRunnerOptions {
  readonly productionRunStore?: ProductionRunStore;
  readonly authority?: ProductionRunAuthority;
  readonly firstPartyLibrary?: NodeLibrary;
}

export interface WorkflowResumeOptions extends WorkflowRunnerOptions {
  readonly approvalId?: string;
  readonly approvalRequestedSeq?: number;
  readonly approvalExpiresAtSeq?: number;
}

const LOCAL_WORKFLOW_AUTHORITY: ProductionRunAuthority = {
  principalId: 'local-owner',
  role: 'owner',
  displayName: 'Local owner',
};
let runIdSequence = 0;

export function defaultWorkflowAuthority(): ProductionRunAuthority {
  return LOCAL_WORKFLOW_AUTHORITY;
}

export function resetFirstPartyLibraryForTests(): void {
  // Kept as a no-op compatibility seam for older focused tests. First-party
  // tests must now pass an explicit fixture library to `runWorkflow`.
}

function productionLibraryFor(options: WorkflowRunnerOptions): NodeLibrary {
  return options.firstPartyLibrary ?? createProductionFirstPartyLibrary();
}

function spikeCommandsFor(commands: readonly CommandLike[]): SpikeCommand[] {
  const mapped: SpikeCommand[] = [];
  for (const cmd of commands) {
    const payload = cmd.arguments as Record<string, unknown>;
    switch (cmd.tool) {
      case 'insertClip':
        mapped.push({ type: 'timeline.insertClip', payload } as unknown as SpikeCommand);
        break;
      case 'removeClip':
        mapped.push({ type: 'timeline.removeClip', payload } as unknown as SpikeCommand);
        break;
      case 'moveClip':
        mapped.push({ type: 'timeline.moveClip', payload } as unknown as SpikeCommand);
        break;
      case 'trimClip': {
        if (typeof payload.newStartUs === 'number') {
          mapped.push({ type: 'timeline.trimClipStart', payload } as unknown as SpikeCommand);
        }
        if (typeof payload.newEndUs === 'number') {
          mapped.push({ type: 'timeline.trimClipEnd', payload } as unknown as SpikeCommand);
        }
        break;
      }
      case 'splitClip':
        mapped.push({ type: 'timeline.splitClip', payload } as unknown as SpikeCommand);
        break;
      case 'joinClips':
        mapped.push({ type: 'timeline.joinClips', payload } as unknown as SpikeCommand);
        break;
      default:
        throw new Error(`Unsupported workflow command: ${cmd.tool}`);
    }
  }
  return mapped;
}

function kahnTopoOrder(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
): readonly string[] {
  const indegree = new Map<string, number>();
  const downstream = new Map<string, string[]>();
  for (const node of nodes) {
    indegree.set(node.id, 0);
    downstream.set(node.id, []);
  }
  for (const edge of edges) {
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    downstream.get(edge.from)?.push(edge.to);
  }
  const ready = nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift();
    if (id === undefined) {
      continue;
    }
    order.push(id);
    for (const next of downstream.get(id) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) {
        ready.push(next);
      }
    }
  }
  return order;
}

function resolveWorkflow(session: EditorSession, workflowId: string): JoyWorkflow {
  const recorded = loadWorkflow(session, workflowId);
  if (recorded !== undefined) {
    return recorded.workflow;
  }
  const system = getFirstPartyWorkflow(workflowId);
  if (system !== undefined) {
    return system.workflow;
  }
  throw new Error(`Workflow not found: ${workflowId}`);
}

/** Normalize editor modal inputs into the first-party workflow input shape. */
export function normalizeFirstPartyInputs(
  workflow: JoyWorkflow,
  inputs: Readonly<Record<string, unknown>>,
): unknown {
  const normalized: Record<string, unknown> = { ...inputs };
  if (normalized.brief === undefined || normalized.brief === '') {
    normalized.brief = 'Create a polished, on-brand edit from the selected media.';
  }
  if (
    normalized.selectedMedia === undefined &&
    typeof normalized.assetId === 'string' &&
    normalized.assetId.trim() !== ''
  ) {
    normalized.selectedMedia = { assetId: normalized.assetId };
  }
  if (typeof normalized.selectedMedia === 'string' && normalized.selectedMedia.trim() !== '') {
    normalized.selectedMedia = { assetId: normalized.selectedMedia };
  }
  const required = (workflow.inputs.required as string[] | undefined) ?? [];
  if (
    required.includes('asset') &&
    normalized.asset === undefined &&
    typeof normalized.assetId === 'string'
  ) {
    normalized.asset = { assetId: normalized.assetId };
  }
  if (typeof normalized.asset === 'string') {
    normalized.asset = { assetId: normalized.asset };
  }
  return normalized;
}

function findPendingApproval(checkpoint: RunCheckpoint):
  | {
      readonly nodeId: string;
      readonly request: HumanInputRequest;
    }
  | undefined {
  for (const [nodeId, record] of Object.entries(checkpoint.nodes)) {
    if (record.state === 'waiting_for_input' && record.pendingRequest !== undefined) {
      return { nodeId, request: record.pendingRequest };
    }
  }
  return undefined;
}

function newRunId(workflowId: string): string {
  runIdSequence += 1;
  return `editor-${workflowId.replaceAll('.', '-')}-${String(Date.now())}-${String(runIdSequence)}`;
}

async function runRecordedWorkflow(
  session: EditorSession,
  workflow: JoyWorkflow,
  inputs: Readonly<Record<string, unknown>>,
): Promise<WorkflowRunOutcome> {
  const runId = newRunId(workflow.id);
  if (workflow.formatVersion !== 1) {
    return {
      status: 'failed',
      workflowId: workflow.id,
      runId,
      error: `Unsupported workflow format version: ${String(workflow.formatVersion)}`,
    };
  }

  const bus = createAgentCommandBus(session);
  const byId = new Map(workflow.nodes.map((n) => [n.id, n]));
  const order = kahnTopoOrder(workflow.nodes, workflow.edges);

  const results = new Map<string, NodeRunResult>();
  for (const nodeId of order) {
    const node = byId.get(nodeId);
    if (node === undefined) {
      continue;
    }

    if (node.category === 'editor' && node.type === 'editor.commandTransaction') {
      const commands = (node.params.commands as readonly CommandLike[] | undefined) ?? [];
      if (commands.length === 0) {
        results.set(nodeId, { nodeId, success: true });
        continue;
      }

      const resolvedCommands = commands.map((cmd) => ({
        ...cmd,
        arguments: resolveParameterizedValue(cmd.arguments, inputs),
      }));
      const spikeCommands = spikeCommandsFor(resolvedCommands);
      const label = (node.params.label as string | undefined) ?? nodeId;
      const result = bus.dispatchTimeline(spikeCommands, label);
      const success = result.success ?? false;
      const nodeResult: NodeRunResult = {
        ...(!success ? { error: result.error } : {}),
        nodeId,
        success,
      };
      results.set(nodeId, nodeResult);
      if (!success && workflow.policy.failure === 'stop') {
        return {
          status: 'failed',
          workflowId: workflow.id,
          runId,
          error: `Workflow stopped at ${nodeId}: ${String(result.error ?? 'unknown error')}`,
        };
      }
    } else {
      const nodeResult: NodeRunResult = {
        nodeId,
        success: false,
        error: `unsupported node type ${node.type}`,
      };
      results.set(nodeId, nodeResult);
      if (workflow.policy.failure === 'stop') {
        return {
          status: 'failed',
          workflowId: workflow.id,
          runId,
          error: `Workflow stopped at ${nodeId}: unsupported node type ${node.type}`,
        };
      }
    }
  }

  return { status: 'succeeded', workflowId: workflow.id, runId };
}

function checkpointRecordFor(
  workflow: JoyWorkflow,
  result: ReturnType<typeof executeWorkflow>,
  recorder: RunRecorder,
  authority: ProductionRunAuthority,
): ProductionRunRecordV1 {
  return createProductionRunRecordFromDashboard({
    dashboard: buildRunDashboard({ workflow, result, recorder }),
    checkpoint: result.checkpoint,
    authority,
  });
}

function boardRunFor(record: ProductionRunRecordV1) {
  const boardRun = buildProductionRunBoardSnapshot([record]).runs[0];
  if (boardRun === undefined) throw new Error('Unable to build production run board projection');
  return boardRun;
}

function waitingOutcomeFromCheckpoint(
  workflowId: string,
  runId: string,
  checkpoint: RunCheckpoint,
  record: ProductionRunRecordV1,
): WorkflowRunOutcome | undefined {
  const pending = findPendingApproval(checkpoint);
  if (pending === undefined) return undefined;
  const approval = record.approvals.find(
    (candidate) => candidate.nodeId === pending.nodeId && candidate.state === 'pending',
  );
  return {
    status: 'waiting_for_input',
    workflowId,
    runId,
    nodeId: pending.nodeId,
    request: pending.request,
    checkpoint,
    ...(approval === undefined
      ? {}
      : {
          approvalId: approval.approvalId,
          approvalRequestedSeq: approval.requestedSeq,
          approvalExpiresAtSeq: approval.requestedSeq,
        }),
  };
}

function outcomeFromCheckpoint(
  workflowId: string,
  runId: string,
  checkpoint: RunCheckpoint,
  record: ProductionRunRecordV1,
): WorkflowRunOutcome {
  if (checkpoint.state === 'waiting_for_input') {
    const waiting = waitingOutcomeFromCheckpoint(workflowId, runId, checkpoint, record);
    if (waiting !== undefined) return waiting;
    return {
      status: 'failed',
      workflowId,
      runId,
      error: 'Workflow parked without a pending approval request',
    };
  }

  if (checkpoint.state === 'failed' || checkpoint.state === 'waiting_for_manual_intervention') {
    const failedNode = Object.entries(checkpoint.nodes).find(([, node]) => node.state === 'failed');
    return {
      status: 'failed',
      workflowId,
      runId,
      error: failedNode?.[1].failureCode ?? `Workflow ended in state ${checkpoint.state}`,
    };
  }

  if (checkpoint.state === 'canceled') {
    return {
      status: 'failed',
      workflowId,
      runId,
      error: 'Workflow run was canceled',
    };
  }

  const outputsNode = checkpoint.nodes['manifest'] ?? checkpoint.nodes['write-manifest'];
  return {
    status: 'succeeded',
    workflowId,
    runId,
    ...(outputsNode?.output !== undefined ? { outputs: outputsNode.output } : {}),
  };
}

async function executeAndPersistFirstPartyWorkflow(
  workflow: JoyWorkflow,
  runId: string,
  projectRevision: string,
  workflowInputs: unknown,
  store: ProductionRunStore,
  authority: ProductionRunAuthority,
  options: {
    readonly expectedRevision: number;
    readonly library: NodeLibrary;
    readonly resumeFrom?: RunCheckpoint;
    readonly humanInputs?: Readonly<Record<string, unknown>>;
  },
): Promise<WorkflowRunOutcome> {
  const recorder = new RunRecorder();
  const result = executeWorkflow({
    workflow,
    runId,
    projectRevision,
    workflowInputs,
    handlers: instrumentHandlers(options.library.handlers, recorder),
    reuseNondeterministic: true,
    ...(options.resumeFrom !== undefined ? { resumeFrom: options.resumeFrom } : {}),
    ...(options.humanInputs !== undefined ? { humanInputs: options.humanInputs } : {}),
  });
  const checkpointRecord = checkpointRecordFor(workflow, result, recorder, authority);
  const update = await store.compareAndSwapCheckpoint({
    runId,
    expectedRevision: options.expectedRevision,
    checkpoint: result.checkpoint,
    dashboard: boardRunFor(checkpointRecord),
    authority,
  });
  if (!update.ok) {
    return {
      status: 'failed',
      workflowId: workflow.id,
      runId,
      error:
        update.reason === 'revision-conflict'
          ? `Production run checkpoint revision conflict: expected ${String(
              options.expectedRevision,
            )}, current ${String(update.currentRevision ?? 'unknown')}`
          : `Production run checkpoint update failed: ${update.reason}`,
    };
  }
  return outcomeFromCheckpoint(workflow.id, runId, result.checkpoint, update.record);
}

async function runFirstPartyWorkflow(
  session: EditorSession,
  workflow: JoyWorkflow,
  inputs: Readonly<Record<string, unknown>>,
  options: WorkflowRunnerOptions = {},
): Promise<WorkflowRunOutcome> {
  const runId = newRunId(workflow.id);
  const library = productionLibraryFor(options);
  const libraryStatus = getProductionFirstPartyLibraryStatus();
  if (isProductionFirstPartyLibrary(library) && !libraryStatus.available) {
    return {
      status: 'failed',
      workflowId: workflow.id,
      runId,
      error: `${libraryStatus.label}: ${libraryStatus.reason} ${libraryStatus.recovery}`,
    };
  }
  const store = options.productionRunStore;
  if (store === undefined) {
    return {
      status: 'failed',
      workflowId: workflow.id,
      runId,
      error: 'ProductionRunStore is required for first-party workflow runs',
    };
  }

  const authority = options.authority ?? defaultWorkflowAuthority();
  const workflowInputs = normalizeFirstPartyInputs(workflow, inputs);
  const projectRevision = session.projectRevisionId;
  const queued: ProductionRunRecordV1 = {
    ...createQueuedProductionRunRecord({
      runId,
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      projectRevision,
      authority,
    }),
    workflowInputs,
  };
  await store.create(queued);

  return executeAndPersistFirstPartyWorkflow(
    workflow,
    runId,
    projectRevision,
    workflowInputs,
    store,
    authority,
    { expectedRevision: 0, library },
  );
}

export async function runWorkflow(
  session: EditorSession,
  workflowId: string,
  inputs: Readonly<Record<string, unknown>> = {},
  options: WorkflowRunnerOptions = {},
): Promise<WorkflowRunOutcome> {
  const recorded = loadWorkflow(session, workflowId);
  if (recorded !== undefined) {
    return runRecordedWorkflow(session, recorded.workflow, inputs);
  }

  const system = getFirstPartyWorkflow(workflowId);
  if (system === undefined) {
    throw new Error(`Workflow not found: ${workflowId}`);
  }
  return runFirstPartyWorkflow(session, system.workflow, inputs, options);
}

export async function resumeWorkflow(
  session: EditorSession,
  runId: string,
  humanInputs: Readonly<Record<string, unknown>>,
  options: WorkflowResumeOptions = {},
): Promise<WorkflowRunOutcome> {
  const store = options.productionRunStore;
  if (store === undefined) {
    return {
      status: 'failed',
      workflowId: 'unknown',
      runId,
      error: 'ProductionRunStore is required to resume first-party workflow runs',
    };
  }

  const record = await store.load(runId);
  if (record === undefined) {
    return {
      status: 'failed',
      workflowId: 'unknown',
      runId,
      error: `No production workflow run: ${runId}`,
    };
  }
  if (record.state === 'canceled' || record.state === 'failed' || record.state === 'succeeded') {
    return {
      status: 'failed',
      workflowId: record.workflowId,
      runId,
      error: `Workflow run is already ${record.state}`,
    };
  }
  if (record.state !== 'parked' || record.checkpoint === undefined) {
    return {
      status: 'failed',
      workflowId: record.workflowId,
      runId,
      error: `Workflow run is not parked: ${record.state}`,
    };
  }

  const library = productionLibraryFor(options);
  if (isProductionFirstPartyLibrary(library)) {
    const status = getProductionFirstPartyLibraryStatus();
    if (!status.available) {
      return {
        status: 'failed',
        workflowId: record.workflowId,
        runId,
        error: `${status.label}: ${status.reason} ${status.recovery}`,
      };
    }
  }

  const workflow = resolveWorkflow(session, record.workflowId);
  if (workflow.version !== record.workflowVersion) {
    return {
      status: 'failed',
      workflowId: record.workflowId,
      runId,
      error: 'Stored workflow version does not match the current workflow definition',
    };
  }

  const pending = findPendingApproval(record.checkpoint);
  if (pending === undefined) {
    return {
      status: 'failed',
      workflowId: record.workflowId,
      runId,
      error: 'Stored checkpoint has no pending approval request',
    };
  }
  const approval = record.approvals.find(
    (candidate) => candidate.nodeId === pending.nodeId && candidate.state === 'pending',
  );
  if (approval === undefined) {
    return {
      status: 'failed',
      workflowId: record.workflowId,
      runId,
      error: 'Approval request is not pending',
    };
  }
  if (options.approvalId !== undefined && approval.approvalId !== options.approvalId) {
    return {
      status: 'failed',
      workflowId: record.workflowId,
      runId,
      error: 'Approval response rejected: approval-conflict',
    };
  }
  if (
    options.approvalRequestedSeq !== undefined &&
    approval.requestedSeq !== options.approvalRequestedSeq
  ) {
    return {
      status: 'failed',
      workflowId: record.workflowId,
      runId,
      error: 'Approval response rejected: approval-conflict',
    };
  }

  const authority = options.authority ?? defaultWorkflowAuthority();
  const approved = approvalInputApproved(humanInputs[pending.nodeId]);
  const responseResult = await recordApprovalResponse(store, record, approval, {
    approved,
    authority,
    humanInputs,
    ...(options.approvalId === undefined ? {} : { expectedApprovalId: options.approvalId }),
    ...(options.approvalExpiresAtSeq === undefined
      ? {}
      : { expiresAtSeq: options.approvalExpiresAtSeq }),
  });
  if (!responseResult.ok) {
    return {
      status: 'failed',
      workflowId: record.workflowId,
      runId,
      error: `Approval response rejected: ${responseResult.reason}`,
    };
  }
  if (!approved) {
    return {
      status: 'failed',
      workflowId: record.workflowId,
      runId,
      error: 'Approval response rejected the workflow request',
    };
  }

  return executeAndPersistFirstPartyWorkflow(
    workflow,
    runId,
    record.projectRevision,
    record.workflowInputs ?? {},
    store,
    authority,
    {
      expectedRevision: record.checkpointRevision,
      library,
      resumeFrom: record.checkpoint,
      humanInputs,
    },
  );
}

type ApprovalResponseResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: string };

interface ApprovalStoreWithPolicy extends ProductionRunStore {
  respondToApproval(
    runId: string,
    response: {
      readonly approvalId: string;
      readonly approved: boolean;
      readonly responseRef: string;
      readonly response?: unknown;
      readonly rejectionReason?: string;
      readonly authority: ProductionRunAuthority;
      readonly expectedApprovalId?: string;
      readonly expectedRequestedSeq?: number;
      readonly expiresAtSeq?: number;
    },
  ): Promise<
    | { readonly ok: true; readonly duplicate: boolean; readonly record: ProductionRunRecordV1 }
    | { readonly ok: false; readonly reason: string }
  >;
}

function hasPolicyApprovalResponse(store: ProductionRunStore): store is ApprovalStoreWithPolicy {
  return typeof (store as { respondToApproval?: unknown }).respondToApproval === 'function';
}

async function recordApprovalResponse(
  store: ProductionRunStore,
  record: ProductionRunRecordV1,
  approval: ProductionApprovalV1,
  input: {
    readonly approved: boolean;
    readonly authority: ProductionRunAuthority;
    readonly humanInputs: Readonly<Record<string, unknown>>;
    readonly expectedApprovalId?: string;
    readonly expiresAtSeq?: number;
  },
): Promise<ApprovalResponseResult> {
  const response = {
    approvalId: approval.approvalId,
    approved: input.approved,
    responseRef: approvalResponseRef(record, approval, input.humanInputs),
    response: input.humanInputs[approval.nodeId],
    ...(() => {
      const reason = approvalRejectionReason(input.humanInputs[approval.nodeId]);
      return reason === undefined ? {} : { rejectionReason: reason };
    })(),
    authority: input.authority,
  };
  const result = hasPolicyApprovalResponse(store)
    ? await store.respondToApproval(record.runId, {
        ...response,
        ...(input.expectedApprovalId === undefined
          ? {}
          : { expectedApprovalId: input.expectedApprovalId }),
        expectedRequestedSeq: approval.requestedSeq,
        ...(input.expiresAtSeq === undefined ? {} : { expiresAtSeq: input.expiresAtSeq }),
      })
    : await store.recordApprovalResponse(record.runId, response);
  return result.ok ? { ok: true } : { ok: false, reason: result.reason };
}

function approvalResponseRef(
  record: ProductionRunRecordV1,
  approval: ProductionApprovalV1,
  humanInputs: Readonly<Record<string, unknown>>,
): string {
  const key = computeRunKey({
    workflowId: record.workflowId,
    workflowVersion: record.workflowVersion,
    nodeId: approval.nodeId,
    nodeType: 'human.response',
    params: { approvalId: approval.approvalId, humanInputs },
    normalizedInputs: record.runId,
    projectRevision: record.projectRevision,
  });
  return `response-${key.slice(0, 48)}`;
}

function approvalInputApproved(input: unknown): boolean {
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    const approved = (input as { readonly approved?: unknown }).approved;
    const rejected = (input as { readonly rejected?: unknown }).rejected;
    if (approved === false || rejected === true) return false;
  }
  return true;
}

function approvalRejectionReason(input: unknown): string | undefined {
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    const reason = (input as { readonly rejectionReason?: unknown }).rejectionReason;
    if (typeof reason === 'string' && reason.trim().length > 0) return reason.trim();
  }
  return undefined;
}

export { resolveWorkflow };
