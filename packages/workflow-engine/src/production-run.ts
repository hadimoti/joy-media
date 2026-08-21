/** Task 14 — durable production-run contracts built from workflow checkpoints and dashboards. */

import type {
  HumanInputRequest,
  HumanInputRequestKind,
  NodeCheckpoint,
  RunCheckpoint,
} from './runtime.js';
import { isWorkflowRunStateParked } from './runtime.js';
import type { RunDashboard, RunDashboardNode, RunLogEntry, RunLogLevel } from './operations.js';
import { boundRunLogEntries } from './operations.js';

export const PRODUCTION_RUN_RECORD_VERSION = 1 as const;
export const PRODUCTION_RUN_EVENT_VERSION = 1 as const;
export const PRODUCTION_APPROVAL_VERSION = 1 as const;
export const PRODUCTION_RUN_BOARD_SNAPSHOT_VERSION = 1 as const;

export type ProductionRunStateV1 =
  'queued' | 'running' | 'parked' | 'failed' | 'canceled' | 'succeeded';

export type ProductionRunEventTypeV1 =
  | 'run.queued'
  | 'run.started'
  | 'run.checkpointed'
  | 'run.parked'
  | 'run.failed'
  | 'run.canceled'
  | 'run.succeeded'
  | 'approval.requested'
  | 'approval.responded';

export type ProductionApprovalStateV1 = 'pending' | 'approved' | 'rejected';

export interface ProductionRunAuthority {
  readonly principalId: string;
  readonly role: 'system' | 'owner' | 'operator' | 'reviewer';
  readonly displayName?: string;
}

export interface ProductionRunLinksV1 {
  readonly jobId?: string;
  readonly providerRunId?: string;
  readonly reportId?: string;
  readonly artifactIds?: readonly string[];
}

export interface ProductionRunEventV1 {
  readonly eventVersion: typeof PRODUCTION_RUN_EVENT_VERSION;
  readonly seq: number;
  readonly type: ProductionRunEventTypeV1;
  readonly state: ProductionRunStateV1;
  readonly actor?: ProductionRunAuthority;
  readonly nodeId?: string;
  readonly approvalId?: string;
  readonly checkpointRevision?: number;
  readonly failureCode?: string;
  readonly message?: string;
}

export interface ProductionApprovalV1 {
  readonly approvalVersion: typeof PRODUCTION_APPROVAL_VERSION;
  readonly approvalId: string;
  readonly nodeId: string;
  readonly kind: HumanInputRequestKind;
  readonly prompt: string;
  readonly state: ProductionApprovalStateV1;
  readonly requestedSeq: number;
  readonly respondedSeq?: number;
  readonly responseRef?: string;
  readonly authority?: ProductionRunAuthority;
}

export interface ProductionRunPublicLogEntryV1 {
  readonly seq: number;
  readonly nodeId: string;
  readonly attempt: number;
  readonly level: RunLogLevel;
  readonly message: string;
}

export interface ProductionRunNodeProjectionV1 {
  readonly nodeId: string;
  readonly type: string;
  readonly category: string;
  readonly state: RunDashboardNode['state'];
  readonly attempts: number;
  readonly deterministic: boolean;
  readonly reused: boolean;
  readonly failureCode?: string;
  readonly pendingApprovalId?: string;
  readonly logs: readonly ProductionRunPublicLogEntryV1[];
  readonly artifactIds: readonly string[];
}

export interface ProductionRunRecordV1 {
  readonly recordVersion: typeof PRODUCTION_RUN_RECORD_VERSION;
  readonly runId: string;
  readonly workflowId: string;
  readonly workflowVersion: string;
  readonly projectRevision: string;
  readonly state: ProductionRunStateV1;
  readonly checkpointRevision: number;
  /** Original JSON workflow inputs needed to recompute run keys on durable resume. */
  readonly workflowInputs?: unknown;
  readonly checkpoint?: RunCheckpoint;
  readonly links: ProductionRunLinksV1;
  readonly events: readonly ProductionRunEventV1[];
  readonly approvals: readonly ProductionApprovalV1[];
  readonly nodes: readonly ProductionRunNodeProjectionV1[];
  readonly createdSeq: number;
  readonly updatedSeq: number;
}

export interface CreateQueuedProductionRunRecordOptions {
  readonly runId: string;
  readonly workflowId: string;
  readonly workflowVersion: string;
  readonly projectRevision: string;
  readonly links?: ProductionRunLinksV1;
  readonly authority?: ProductionRunAuthority;
}

export interface ProductionRunDashboardLinksV1 extends ProductionRunLinksV1 {
  readonly artifactIdsByNodeId?: Readonly<Record<string, readonly string[]>>;
}

export interface CreateProductionRunRecordFromDashboardOptions {
  readonly dashboard: RunDashboard;
  readonly checkpoint: RunCheckpoint;
  readonly links?: ProductionRunDashboardLinksV1;
  readonly authority?: ProductionRunAuthority;
  readonly maxLogsPerNode?: number;
  readonly maxArtifactIdsPerNode?: number;
}

export interface AppendProductionRunEventInput {
  readonly type: ProductionRunEventTypeV1;
  readonly state: ProductionRunStateV1;
  readonly actor?: ProductionRunAuthority;
  readonly nodeId?: string;
  readonly approvalId?: string;
  readonly checkpointRevision?: number;
  readonly failureCode?: string;
  readonly message?: string;
}

export interface RecordProductionApprovalResponseInput {
  readonly approvalId: string;
  readonly approved: boolean;
  readonly responseRef: string;
  readonly authority: ProductionRunAuthority;
}

export type RecordProductionApprovalResponseResult =
  | { readonly ok: true; readonly duplicate: boolean; readonly record: ProductionRunRecordV1 }
  | { readonly ok: false; readonly reason: 'approval-not-found' | 'approval-conflict' };

export interface ProductionRunBoardApprovalV1 {
  readonly approvalId: string;
  readonly nodeId: string;
  readonly kind: HumanInputRequestKind;
  readonly prompt: string;
  readonly state: ProductionApprovalStateV1;
}

export interface ProductionRunBoardRunV1 {
  readonly runId: string;
  readonly workflowId: string;
  readonly workflowVersion: string;
  readonly projectRevision: string;
  readonly state: ProductionRunStateV1;
  readonly checkpointRevision: number;
  readonly links: ProductionRunLinksV1;
  readonly counts: RunDashboard['counts'];
  readonly approvals: readonly ProductionRunBoardApprovalV1[];
  readonly nodes: readonly ProductionRunNodeProjectionV1[];
  readonly lastEventSeq: number;
}

export interface ProductionRunBoardSnapshotV1 {
  readonly snapshotVersion: typeof PRODUCTION_RUN_BOARD_SNAPSHOT_VERSION;
  readonly counts: Readonly<Partial<Record<ProductionRunStateV1, number>>>;
  readonly runs: readonly ProductionRunBoardRunV1[];
}

export interface ProductionRunCheckpointUpdateV1 {
  readonly runId: string;
  readonly expectedRevision: number;
  readonly checkpoint: RunCheckpoint;
  readonly dashboard?: ProductionRunBoardRunV1;
  readonly authority?: ProductionRunAuthority;
}

export type ProductionRunCheckpointUpdateResultV1 =
  | { readonly ok: true; readonly record: ProductionRunRecordV1 }
  | {
      readonly ok: false;
      readonly reason: 'not-found' | 'revision-conflict';
      readonly currentRevision?: number;
    };

export interface ProductionRunStore {
  load(runId: string): Promise<ProductionRunRecordV1 | undefined>;
  create(record: ProductionRunRecordV1): Promise<void>;
  compareAndSwapCheckpoint(
    update: ProductionRunCheckpointUpdateV1,
  ): Promise<ProductionRunCheckpointUpdateResultV1>;
  recordApprovalResponse(
    runId: string,
    response: RecordProductionApprovalResponseInput,
  ): Promise<RecordProductionApprovalResponseResult>;
}

export function productionRunStateFromWorkflowRunState(
  state: RunCheckpoint['state'],
): ProductionRunStateV1 {
  if (state === 'succeeded' || state === 'failed' || state === 'canceled') {
    return state;
  }
  if (isWorkflowRunStateParked(state)) {
    return 'parked';
  }
  return 'running';
}

export function createQueuedProductionRunRecord(
  options: CreateQueuedProductionRunRecordOptions,
): ProductionRunRecordV1 {
  const event = createProductionRunEvent(
    1,
    {
      type: 'run.queued',
      state: 'queued',
      message: 'production run queued',
      ...(options.authority === undefined ? {} : { actor: options.authority }),
    },
    0,
  );
  return {
    recordVersion: PRODUCTION_RUN_RECORD_VERSION,
    runId: options.runId,
    workflowId: options.workflowId,
    workflowVersion: options.workflowVersion,
    projectRevision: options.projectRevision,
    state: 'queued',
    checkpointRevision: 0,
    links: compactLinks(options.links),
    events: [event],
    approvals: [],
    nodes: [],
    createdSeq: 1,
    updatedSeq: 1,
  };
}

export function markProductionRunRunning(
  record: ProductionRunRecordV1,
  authority?: ProductionRunAuthority,
): ProductionRunRecordV1 {
  return appendProductionRunEvent(record, {
    type: 'run.started',
    state: 'running',
    message: 'production run started',
    ...(authority === undefined ? {} : { actor: authority }),
  });
}

export function appendProductionRunEvent(
  record: ProductionRunRecordV1,
  input: AppendProductionRunEventInput,
): ProductionRunRecordV1 {
  const seq = nextSequence(record);
  const event = createProductionRunEvent(seq, input, record.checkpointRevision);
  const events = [...record.events, event];
  assertMonotonicProductionRunEvents(events);
  return {
    ...record,
    state: input.state,
    events,
    updatedSeq: seq,
  };
}

export function createProductionRunRecordFromDashboard(
  options: CreateProductionRunRecordFromDashboardOptions,
): ProductionRunRecordV1 {
  const { dashboard, checkpoint } = options;
  const state = productionRunStateFromWorkflowRunState(checkpoint.state);
  const checkpointRevision = 1;
  const firstEventType = eventTypeForState(state);
  const event = createProductionRunEvent(
    1,
    {
      type: firstEventType,
      state,
      checkpointRevision,
      message: `production run ${state}`,
      ...(options.authority === undefined ? {} : { actor: options.authority }),
    },
    checkpointRevision,
  );
  const approvalEvents = approvalEventsFromDashboard(dashboard, 2);
  const events = [event, ...approvalEvents];
  assertMonotonicProductionRunEvents(events);
  const approvals = approvalsFromDashboard(dashboard, approvalEvents);

  return {
    recordVersion: PRODUCTION_RUN_RECORD_VERSION,
    runId: dashboard.runId,
    workflowId: dashboard.workflowId,
    workflowVersion: dashboard.workflowVersion,
    projectRevision: dashboard.projectRevision,
    state,
    checkpointRevision,
    checkpoint: sanitizeCheckpoint(checkpoint),
    links: compactLinks(options.links),
    events,
    approvals,
    nodes: nodesFromDashboard(dashboard, approvals, options.links, {
      ...(options.maxLogsPerNode === undefined ? {} : { maxLogsPerNode: options.maxLogsPerNode }),
      ...(options.maxArtifactIdsPerNode === undefined
        ? {}
        : { maxArtifactIdsPerNode: options.maxArtifactIdsPerNode }),
    }),
    createdSeq: 1,
    updatedSeq: events.at(-1)?.seq ?? 1,
  };
}

export function recordProductionApprovalResponse(
  record: ProductionRunRecordV1,
  input: RecordProductionApprovalResponseInput,
): RecordProductionApprovalResponseResult {
  const approval = record.approvals.find((candidate) => candidate.approvalId === input.approvalId);
  if (approval === undefined) {
    return { ok: false, reason: 'approval-not-found' };
  }

  const nextState: ProductionApprovalStateV1 = input.approved ? 'approved' : 'rejected';
  if (approval.state !== 'pending') {
    if (approval.state === nextState && approval.responseRef === input.responseRef) {
      return { ok: true, duplicate: true, record };
    }
    return { ok: false, reason: 'approval-conflict' };
  }

  const seq = nextSequence(record);
  const updatedApproval: ProductionApprovalV1 = {
    ...approval,
    state: nextState,
    respondedSeq: seq,
    responseRef: input.responseRef,
    authority: input.authority,
  };
  const event = createProductionRunEvent(
    seq,
    {
      type: 'approval.responded',
      state: record.state,
      actor: input.authority,
      nodeId: approval.nodeId,
      approvalId: approval.approvalId,
      message: nextState,
    },
    record.checkpointRevision,
  );
  const approvals = record.approvals.map((candidate) =>
    candidate.approvalId === approval.approvalId ? updatedApproval : candidate,
  );
  const nodes = record.nodes.map((candidate) => {
    if (candidate.pendingApprovalId !== approval.approvalId) {
      return candidate;
    }
    const { pendingApprovalId: _pendingApprovalId, ...withoutPendingApproval } = candidate;
    void _pendingApprovalId;
    return withoutPendingApproval;
  });
  const events = [...record.events, event];
  assertMonotonicProductionRunEvents(events);
  return {
    ok: true,
    duplicate: false,
    record: {
      ...record,
      events,
      approvals,
      nodes,
      updatedSeq: seq,
    },
  };
}

export function buildProductionRunBoardSnapshot(
  records: readonly ProductionRunRecordV1[],
): ProductionRunBoardSnapshotV1 {
  const counts: Partial<Record<ProductionRunStateV1, number>> = {};
  const runs = records.map((record) => {
    counts[record.state] = (counts[record.state] ?? 0) + 1;
    return {
      runId: record.runId,
      workflowId: record.workflowId,
      workflowVersion: record.workflowVersion,
      projectRevision: record.projectRevision,
      state: record.state,
      checkpointRevision: record.checkpointRevision,
      links: record.links,
      counts: nodeCounts(record.nodes),
      approvals: record.approvals.map((approval) => ({
        approvalId: approval.approvalId,
        nodeId: approval.nodeId,
        kind: approval.kind,
        prompt: approval.prompt,
        state: approval.state,
      })),
      nodes: record.nodes,
      lastEventSeq: record.events.at(-1)?.seq ?? 0,
    };
  });
  return {
    snapshotVersion: PRODUCTION_RUN_BOARD_SNAPSHOT_VERSION,
    counts,
    runs,
  };
}

export function assertMonotonicProductionRunEvents(events: readonly ProductionRunEventV1[]): void {
  let previous = 0;
  for (const event of events) {
    if (event.seq <= previous) {
      throw new Error('production run events must be strictly monotonic');
    }
    previous = event.seq;
  }
}

export class InMemoryProductionRunStore implements ProductionRunStore {
  private readonly records = new Map<string, ProductionRunRecordV1>();

  async load(runId: string): Promise<ProductionRunRecordV1 | undefined> {
    return this.records.get(runId);
  }

  async create(record: ProductionRunRecordV1): Promise<void> {
    this.records.set(record.runId, record);
  }

  async compareAndSwapCheckpoint(
    update: ProductionRunCheckpointUpdateV1,
  ): Promise<ProductionRunCheckpointUpdateResultV1> {
    const current = this.records.get(update.runId);
    if (current === undefined) {
      return { ok: false, reason: 'not-found' };
    }
    if (current.checkpointRevision !== update.expectedRevision) {
      return {
        ok: false,
        reason: 'revision-conflict',
        currentRevision: current.checkpointRevision,
      };
    }
    const checkpointRevision = current.checkpointRevision + 1;
    const state = productionRunStateFromWorkflowRunState(update.checkpoint.state);
    const event = createProductionRunEvent(
      nextSequence(current),
      {
        type: eventTypeForState(state, 'run.checkpointed'),
        state,
        checkpointRevision,
        message: `checkpoint revision ${String(checkpointRevision)}`,
        ...(update.authority === undefined ? {} : { actor: update.authority }),
      },
      checkpointRevision,
    );
    const nextApprovals = update.dashboard?.approvals.map((approval) => ({
      approvalVersion: PRODUCTION_APPROVAL_VERSION,
      approvalId: approval.approvalId,
      nodeId: approval.nodeId,
      kind: approval.kind,
      prompt: approval.prompt,
      state: approval.state,
      requestedSeq: event.seq,
    }));
    const record: ProductionRunRecordV1 = {
      ...current,
      state,
      checkpointRevision,
      checkpoint: sanitizeCheckpoint(update.checkpoint),
      events: [...current.events, event],
      nodes: update.dashboard?.nodes ?? current.nodes,
      approvals:
        nextApprovals === undefined
          ? current.approvals
          : mergeProductionApprovals(current.approvals, nextApprovals),
      updatedSeq: event.seq,
    };
    assertMonotonicProductionRunEvents(record.events);
    this.records.set(update.runId, record);
    return { ok: true, record };
  }

  async recordApprovalResponse(
    runId: string,
    response: RecordProductionApprovalResponseInput,
  ): Promise<RecordProductionApprovalResponseResult> {
    const current = this.records.get(runId);
    if (current === undefined) {
      return { ok: false, reason: 'approval-not-found' };
    }
    const result = recordProductionApprovalResponse(current, response);
    if (result.ok) {
      this.records.set(runId, result.record);
    }
    return result;
  }
}

function mergeProductionApprovals(
  current: readonly ProductionApprovalV1[],
  next: readonly ProductionApprovalV1[],
): readonly ProductionApprovalV1[] {
  const nextById = new Map(next.map((approval) => [approval.approvalId, approval]));
  const merged = current.map((approval) => nextById.get(approval.approvalId) ?? approval);
  const currentIds = new Set(current.map((approval) => approval.approvalId));
  return [...merged, ...next.filter((approval) => !currentIds.has(approval.approvalId))];
}

function createProductionRunEvent(
  seq: number,
  input: AppendProductionRunEventInput,
  fallbackCheckpointRevision: number,
): ProductionRunEventV1 {
  return {
    eventVersion: PRODUCTION_RUN_EVENT_VERSION,
    seq,
    type: input.type,
    state: input.state,
    ...(input.actor === undefined ? {} : { actor: input.actor }),
    ...(input.nodeId === undefined ? {} : { nodeId: input.nodeId }),
    ...(input.approvalId === undefined ? {} : { approvalId: input.approvalId }),
    checkpointRevision: input.checkpointRevision ?? fallbackCheckpointRevision,
    ...(input.failureCode === undefined ? {} : { failureCode: input.failureCode }),
    ...(input.message === undefined ? {} : { message: input.message }),
  };
}

function nextSequence(record: ProductionRunRecordV1): number {
  return (record.events.at(-1)?.seq ?? 0) + 1;
}

function eventTypeForState(
  state: ProductionRunStateV1,
  checkpointEventType: ProductionRunEventTypeV1 = 'run.checkpointed',
): ProductionRunEventTypeV1 {
  switch (state) {
    case 'queued':
      return 'run.queued';
    case 'running':
      return checkpointEventType;
    case 'parked':
      return 'run.parked';
    case 'failed':
      return 'run.failed';
    case 'canceled':
      return 'run.canceled';
    case 'succeeded':
      return 'run.succeeded';
  }
}

function compactLinks(links: ProductionRunLinksV1 | undefined): ProductionRunLinksV1 {
  return {
    ...(links?.jobId === undefined ? {} : { jobId: links.jobId }),
    ...(links?.providerRunId === undefined ? {} : { providerRunId: links.providerRunId }),
    ...(links?.reportId === undefined ? {} : { reportId: links.reportId }),
    ...(links?.artifactIds === undefined ? {} : { artifactIds: [...links.artifactIds] }),
  };
}

function approvalEventsFromDashboard(
  dashboard: RunDashboard,
  firstSeq: number,
): readonly ProductionRunEventV1[] {
  const events: ProductionRunEventV1[] = [];
  let seq = firstSeq;
  for (const node of dashboard.nodes) {
    if (node.pendingRequest === undefined) {
      continue;
    }
    events.push(
      createProductionRunEvent(
        seq,
        {
          type: 'approval.requested',
          state: 'parked',
          nodeId: node.nodeId,
          approvalId: approvalIdForNode(dashboard.runId, node),
          message: node.pendingRequest.kind,
        },
        1,
      ),
    );
    seq += 1;
  }
  return events;
}

function approvalsFromDashboard(
  dashboard: RunDashboard,
  approvalEvents: readonly ProductionRunEventV1[],
): readonly ProductionApprovalV1[] {
  const requestedSeqByApprovalId = new Map(
    approvalEvents.map((event) => [event.approvalId, event.seq] as const),
  );
  return dashboard.nodes.flatMap((node) => {
    if (node.pendingRequest === undefined) {
      return [];
    }
    const approvalId = approvalIdForNode(dashboard.runId, node);
    return [
      {
        approvalVersion: PRODUCTION_APPROVAL_VERSION,
        approvalId,
        nodeId: node.nodeId,
        kind: node.pendingRequest.kind,
        prompt: node.pendingRequest.prompt,
        state: 'pending',
        requestedSeq: requestedSeqByApprovalId.get(approvalId) ?? 1,
      },
    ];
  });
}

function nodesFromDashboard(
  dashboard: RunDashboard,
  approvals: readonly ProductionApprovalV1[],
  links: ProductionRunDashboardLinksV1 | undefined,
  bounds: { readonly maxLogsPerNode?: number; readonly maxArtifactIdsPerNode?: number },
): readonly ProductionRunNodeProjectionV1[] {
  const approvalByNode = new Map(approvals.map((approval) => [approval.nodeId, approval]));
  return dashboard.nodes.map((node) => {
    const pendingApproval = approvalByNode.get(node.nodeId);
    return {
      nodeId: node.nodeId,
      type: node.type,
      category: node.category,
      state: node.state,
      attempts: node.attempts,
      deterministic: node.deterministic,
      reused: node.reused,
      ...(node.failureCode === undefined ? {} : { failureCode: node.failureCode }),
      ...(pendingApproval === undefined ? {} : { pendingApprovalId: pendingApproval.approvalId }),
      logs: sanitizeLogs(node.logs, bounds.maxLogsPerNode),
      artifactIds: boundArtifactIds(
        links?.artifactIdsByNodeId?.[node.nodeId] ?? [],
        bounds.maxArtifactIdsPerNode,
      ),
    };
  });
}

function sanitizeLogs(
  logs: readonly RunLogEntry[],
  maxLogsPerNode: number | undefined,
): readonly ProductionRunPublicLogEntryV1[] {
  return boundRunLogEntries(logs, maxLogsPerNode).map((entry) => ({
    seq: entry.seq,
    nodeId: entry.nodeId,
    attempt: entry.attempt,
    level: entry.level,
    message: entry.message,
  }));
}

function boundArtifactIds(
  artifactIds: readonly string[],
  maxArtifactIdsPerNode: number | undefined,
): readonly string[] {
  if (maxArtifactIdsPerNode === undefined) {
    return [...artifactIds];
  }
  if (!Number.isInteger(maxArtifactIdsPerNode) || maxArtifactIdsPerNode < 0) {
    throw new RangeError('maxArtifactIdsPerNode must be a non-negative integer');
  }
  return artifactIds.slice(Math.max(artifactIds.length - maxArtifactIdsPerNode, 0));
}

function approvalIdForNode(
  runId: string,
  node: Pick<RunDashboardNode, 'nodeId' | 'runKey'>,
): string {
  return `${runId}:${node.nodeId}:${node.runKey}`;
}

function nodeCounts(nodes: readonly ProductionRunNodeProjectionV1[]): RunDashboard['counts'] {
  const counts: Partial<Record<ProductionRunNodeProjectionV1['state'], number>> = {};
  for (const node of nodes) {
    counts[node.state] = (counts[node.state] ?? 0) + 1;
  }
  return counts;
}

function sanitizeCheckpoint(checkpoint: RunCheckpoint): RunCheckpoint {
  const nodes: Record<string, NodeCheckpoint> = {};
  for (const [nodeId, node] of Object.entries(checkpoint.nodes)) {
    nodes[nodeId] = {
      runKey: node.runKey,
      state: node.state,
      attempts: node.attempts,
      deterministic: node.deterministic,
      ...(node.failureCode === undefined ? {} : { failureCode: node.failureCode }),
      ...(node.output === undefined ? {} : { output: node.output }),
      ...(node.pendingRequest === undefined
        ? {}
        : {
            pendingRequest: sanitizeHumanInputRequest(node.pendingRequest),
          }),
      ...(node.resolvedInput === undefined ? {} : { resolvedInput: node.resolvedInput }),
    };
  }
  return {
    checkpointVersion: checkpoint.checkpointVersion,
    runId: checkpoint.runId,
    workflowId: checkpoint.workflowId,
    workflowVersion: checkpoint.workflowVersion,
    projectRevision: checkpoint.projectRevision,
    state: checkpoint.state,
    nodes,
  };
}

function sanitizeHumanInputRequest(request: HumanInputRequest): HumanInputRequest {
  return {
    kind: request.kind,
    prompt: request.prompt,
  };
}
