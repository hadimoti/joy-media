import type { BrowserKeyValueStore } from '@joy-media/project-persistence';
import {
  PRODUCTION_APPROVAL_VERSION,
  appendProductionRunEvent,
  assertMonotonicProductionRunEvents,
  productionRunStateFromWorkflowRunState,
  recordProductionApprovalResponse,
  type ProductionRunAuthority,
  type ProductionRunCheckpointUpdateResultV1,
  type ProductionRunCheckpointUpdateV1,
  type ProductionRunEventTypeV1,
  type ProductionRunRecordV1,
  type ProductionRunStateV1,
  type ProductionRunStore,
  type RecordProductionApprovalResponseInput,
  type RecordProductionApprovalResponseResult,
  type NodeCheckpoint,
  type RunCheckpoint,
} from '@joy-media/workflow-engine';

const STORAGE_PREFIX = 'joy-media.production-runs.local.v1';
const STORAGE_VERSION = 1;
const DEFAULT_PAGE_LIMIT = 25;
const MAX_PAGE_LIMIT = 100;
const DEFAULT_MAX_LOG_MESSAGE_BYTES = 8_192;
const DEFAULT_MAX_LOGS_PER_NODE = 100;

export interface BrowserProductionRunScope {
  readonly projectId: string;
  readonly authority: ProductionRunAuthority;
}

export interface BrowserProductionRunStoreOptions {
  readonly maxLogMessageBytes?: number;
  readonly maxLogsPerNode?: number;
}

export interface BrowserProductionRunCreateOptions {
  readonly runKey?: string;
}

export interface BrowserProductionRunListOptions {
  readonly limit?: number;
  readonly cursor?: string;
  readonly state?: ProductionRunStateV1;
}

export interface BrowserProductionRunListResult {
  readonly runs: readonly ProductionRunRecordV1[];
  readonly nextCursor?: string;
}

export interface BrowserProductionRunApprovalResponseInput extends RecordProductionApprovalResponseInput {
  readonly expectedRequestedSeq?: number;
  readonly expiresAtSeq?: number;
}

export type BrowserProductionRunApprovalResponseResult =
  | RecordProductionApprovalResponseResult
  | { readonly ok: false; readonly reason: 'approval-expired' };

export type BrowserProductionRunCancelResult =
  | { readonly ok: true; readonly record: ProductionRunRecordV1 }
  | {
      readonly ok: false;
      readonly reason: 'not-found' | 'revision-conflict' | 'already-terminal';
      readonly currentRevision?: number;
    };

interface BrowserProductionRunDatabase {
  readonly version: typeof STORAGE_VERSION;
  readonly runs: readonly ProductionRunRecordV1[];
  readonly runKeys: readonly {
    readonly key: string;
    readonly runId: string;
  }[];
}

/**
 * Browser-only production run history for explicit local/offline execution.
 *
 * The storage key includes both project and actor authority, so this store never
 * attempts to reconcile local records with the authenticated control-plane API.
 */
export class BrowserProductionRunStore implements ProductionRunStore {
  readonly #records = new Map<string, ProductionRunRecordV1>();
  readonly #runKeys = new Map<string, string>();
  readonly #storageKey: string;
  readonly #maxLogMessageBytes: number;
  readonly #maxLogsPerNode: number;

  constructor(
    private readonly storage: BrowserKeyValueStore,
    private readonly scope: BrowserProductionRunScope,
    options: BrowserProductionRunStoreOptions = {},
  ) {
    this.#storageKey = `${STORAGE_PREFIX}:${encodeURIComponent(scope.projectId)}:${encodeURIComponent(
      scope.authority.principalId,
    )}`;
    this.#maxLogMessageBytes = options.maxLogMessageBytes ?? DEFAULT_MAX_LOG_MESSAGE_BYTES;
    this.#maxLogsPerNode = options.maxLogsPerNode ?? DEFAULT_MAX_LOGS_PER_NODE;

    const database = readDatabase(storage.getItem(this.#storageKey));
    for (const record of database.runs) {
      if (isProductionRunRecord(record)) {
        this.#records.set(record.runId, cloneJson(record));
      }
    }
    for (const runKey of database.runKeys) {
      if (typeof runKey.key === 'string' && typeof runKey.runId === 'string') {
        this.#runKeys.set(runKey.key, runKey.runId);
      }
    }
  }

  async load(runId: string): Promise<ProductionRunRecordV1 | undefined> {
    const record = this.#records.get(runId);
    return record === undefined ? undefined : cloneJson(record);
  }

  async list(
    options: BrowserProductionRunListOptions = {},
  ): Promise<BrowserProductionRunListResult> {
    const limit = boundedLimit(options.limit);
    const offset = cursorOffset(options.cursor);
    const runs = [...this.#records.values()]
      .filter((record) => options.state === undefined || record.state === options.state)
      .sort(
        (left, right) =>
          left.createdSeq - right.createdSeq || left.runId.localeCompare(right.runId),
      );
    const page = runs.slice(offset, offset + limit).map((record) => cloneJson(record));
    const nextOffset = offset + page.length;
    return {
      runs: page,
      ...(nextOffset < runs.length ? { nextCursor: String(nextOffset) } : {}),
    };
  }

  async create(record: ProductionRunRecordV1): Promise<void> {
    await this.createLocalRun(record);
  }

  async createLocalRun(
    record: ProductionRunRecordV1,
    options: BrowserProductionRunCreateOptions = {},
  ): Promise<void> {
    this.#assertRecordCanPersist(record);
    if (this.#records.has(record.runId)) {
      throw new Error(`PRODUCTION_RUN_EXISTS: ${record.runId}`);
    }
    if (options.runKey !== undefined && this.#runKeys.has(options.runKey)) {
      throw new Error(`PRODUCTION_RUN_KEY_EXISTS: ${options.runKey}`);
    }
    this.#records.set(record.runId, cloneJson(record));
    if (options.runKey !== undefined) {
      this.#runKeys.set(options.runKey, record.runId);
    }
    this.#write();
  }

  async compareAndSwapCheckpoint(
    update: ProductionRunCheckpointUpdateV1,
  ): Promise<ProductionRunCheckpointUpdateResultV1> {
    this.#assertScopeAuthority(update.authority);
    const current = this.#records.get(update.runId);
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
    const withEvent = appendProductionRunEvent(current, {
      type: eventTypeForState(state),
      state,
      actor: update.authority,
      checkpointRevision,
      message: `checkpoint revision ${String(checkpointRevision)}`,
    });
    const record: ProductionRunRecordV1 = {
      ...withEvent,
      checkpointRevision,
      checkpoint: sanitizeCheckpoint(update.checkpoint),
      nodes: update.dashboard?.nodes ?? current.nodes,
      approvals:
        update.dashboard?.approvals.map((approval) => ({
          approvalVersion: PRODUCTION_APPROVAL_VERSION,
          approvalId: approval.approvalId,
          nodeId: approval.nodeId,
          kind: approval.kind,
          prompt: approval.prompt,
          state: approval.state,
          requestedSeq: withEvent.updatedSeq,
        })) ?? current.approvals,
    };
    this.#assertRecordCanPersist(record);
    this.#records.set(update.runId, cloneJson(record));
    this.#write();
    return { ok: true, record: cloneJson(record) };
  }

  async recordApprovalResponse(
    runId: string,
    response: RecordProductionApprovalResponseInput,
  ): Promise<RecordProductionApprovalResponseResult> {
    this.#assertScopeAuthority(response.authority);
    const current = this.#records.get(runId);
    if (current === undefined) {
      return { ok: false, reason: 'approval-not-found' };
    }
    const result = recordProductionApprovalResponse(current, response);
    if (result.ok) {
      this.#assertRecordCanPersist(result.record);
      this.#records.set(runId, cloneJson(result.record));
      this.#write();
      return { ...result, record: cloneJson(result.record) };
    }
    return result;
  }

  async respondToApproval(
    runId: string,
    response: BrowserProductionRunApprovalResponseInput,
  ): Promise<BrowserProductionRunApprovalResponseResult> {
    this.#assertScopeAuthority(response.authority);
    const current = this.#records.get(runId);
    if (current === undefined) {
      return { ok: false, reason: 'approval-not-found' };
    }
    const approval = current.approvals.find(
      (candidate) => candidate.approvalId === response.approvalId,
    );
    if (approval === undefined) {
      return { ok: false, reason: 'approval-not-found' };
    }
    if (
      response.expectedRequestedSeq !== undefined &&
      approval.requestedSeq !== response.expectedRequestedSeq
    ) {
      return { ok: false, reason: 'approval-conflict' };
    }
    if (response.expiresAtSeq !== undefined && current.updatedSeq > response.expiresAtSeq) {
      return { ok: false, reason: 'approval-expired' };
    }

    const result = recordProductionApprovalResponse(current, response);
    if (result.ok) {
      this.#assertRecordCanPersist(result.record);
      this.#records.set(runId, cloneJson(result.record));
      this.#write();
      return { ...result, record: cloneJson(result.record) };
    }
    return result;
  }

  async cancel(
    runId: string,
    input: {
      readonly authority: ProductionRunAuthority;
      readonly expectedRevision?: number;
    },
  ): Promise<BrowserProductionRunCancelResult> {
    this.#assertScopeAuthority(input.authority);
    const current = this.#records.get(runId);
    if (current === undefined) {
      return { ok: false, reason: 'not-found' };
    }
    if (
      input.expectedRevision !== undefined &&
      current.checkpointRevision !== input.expectedRevision
    ) {
      return {
        ok: false,
        reason: 'revision-conflict',
        currentRevision: current.checkpointRevision,
      };
    }
    if (isTerminal(current.state)) {
      return { ok: false, reason: 'already-terminal', currentRevision: current.checkpointRevision };
    }

    const record = appendProductionRunEvent(current, {
      type: 'run.canceled',
      state: 'canceled',
      actor: input.authority,
      message: 'production run canceled',
    });
    this.#assertRecordCanPersist(record);
    this.#records.set(runId, cloneJson(record));
    this.#write();
    return { ok: true, record: cloneJson(record) };
  }

  #assertRecordCanPersist(record: ProductionRunRecordV1): void {
    assertMonotonicProductionRunEvents(record.events);
    const firstActor = record.events[0]?.actor;
    if (firstActor === undefined) {
      throw new Error('local production runs require explicit authority');
    }
    this.#assertScopeAuthority(firstActor);
    for (const event of record.events) {
      if (event.actor !== undefined) {
        this.#assertScopeAuthority(event.actor);
      }
    }
    for (const approval of record.approvals) {
      if (approval.authority !== undefined) {
        this.#assertScopeAuthority(approval.authority);
      }
    }
    assertPublicRecord(record, {
      maxLogMessageBytes: this.#maxLogMessageBytes,
      maxLogsPerNode: this.#maxLogsPerNode,
    });
  }

  #assertScopeAuthority(
    authority: ProductionRunAuthority | undefined,
  ): asserts authority is ProductionRunAuthority {
    if (authority === undefined) {
      throw new Error('local production run updates require explicit authority');
    }
    if (authority.principalId !== this.scope.authority.principalId) {
      throw new Error('local production run authority mismatch');
    }
  }

  #write(): void {
    const database: BrowserProductionRunDatabase = {
      version: STORAGE_VERSION,
      runs: [...this.#records.values()].map((record) => cloneJson(record)),
      runKeys: [...this.#runKeys].map(([key, runId]) => ({ key, runId })),
    };
    this.storage.setItem(this.#storageKey, JSON.stringify(database));
  }
}

function eventTypeForState(state: ProductionRunStateV1): ProductionRunEventTypeV1 {
  switch (state) {
    case 'queued':
      return 'run.queued';
    case 'running':
      return 'run.checkpointed';
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

function sanitizeCheckpoint(checkpoint: RunCheckpoint): RunCheckpoint {
  const nodes: Record<string, NodeCheckpoint> = {};
  for (const [nodeId, node] of Object.entries(checkpoint.nodes)) {
    nodes[nodeId] = {
      runKey: node.runKey,
      state: node.state,
      attempts: node.attempts,
      deterministic: node.deterministic,
      ...(node.failureCode === undefined ? {} : { failureCode: node.failureCode }),
      ...(node.pendingRequest === undefined
        ? {}
        : {
            pendingRequest: {
              kind: node.pendingRequest.kind,
              prompt: node.pendingRequest.prompt,
            },
          }),
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

function readDatabase(serialized: string | null): BrowserProductionRunDatabase {
  if (serialized === null) {
    return { version: STORAGE_VERSION, runs: [], runKeys: [] };
  }
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!isRecord(parsed) || parsed.version !== STORAGE_VERSION || !Array.isArray(parsed.runs)) {
      return { version: STORAGE_VERSION, runs: [], runKeys: [] };
    }
    return {
      version: STORAGE_VERSION,
      runs: parsed.runs.filter(isProductionRunRecord),
      runKeys: Array.isArray(parsed.runKeys) ? parsed.runKeys.filter(isRunKeyRecord) : [],
    };
  } catch {
    return { version: STORAGE_VERSION, runs: [], runKeys: [] };
  }
}

function assertPublicRecord(
  record: ProductionRunRecordV1,
  limits: { readonly maxLogMessageBytes: number; readonly maxLogsPerNode: number },
): void {
  assertNoPrivatePayload(record, []);
  for (const node of record.nodes) {
    if (node.logs.length > limits.maxLogsPerNode) {
      throw new Error('oversized production run log');
    }
    for (const log of node.logs) {
      if (utf8Length(log.message) > limits.maxLogMessageBytes) {
        throw new Error('oversized production run log');
      }
    }
  }
}

function assertNoPrivatePayload(value: unknown, path: readonly string[]): void {
  if (isRawMedia(value)) {
    throw new Error(`raw media is not allowed in local production run records (${path.join('.')})`);
  }
  if (typeof value === 'string') {
    if (isPrivateLocalPath(value)) {
      throw new Error(
        `private local path is not allowed in production run records (${path.join('.')})`,
      );
    }
    if (isDataMediaUrl(value)) {
      throw new Error(
        `raw media is not allowed in local production run records (${path.join('.')})`,
      );
    }
    return;
  }
  if (value === null || typeof value !== 'object') {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoPrivatePayload(item, [...path, String(index)]));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if ((key === 'output' || key === 'resolvedInput' || key === 'payload') && child !== undefined) {
      throw new Error(
        `raw media is not allowed in local production run records (${[...path, key].join('.')})`,
      );
    }
    assertNoPrivatePayload(child, [...path, key]);
  }
}

function isPrivateLocalPath(value: string): boolean {
  return (
    /^[A-Za-z]:[\\/]/.test(value) ||
    /^\\\\/.test(value) ||
    /^file:\/\//i.test(value) ||
    /^\/(?:Users|home|Volumes|private|tmp|var|mnt|opt)\//.test(value)
  );
}

function isDataMediaUrl(value: string): boolean {
  return /^data:(?:audio|image|video)\//i.test(value);
}

function isRawMedia(value: unknown): boolean {
  return (
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    (typeof Blob !== 'undefined' && value instanceof Blob)
  );
}

function isTerminal(state: ProductionRunStateV1): boolean {
  return state === 'canceled' || state === 'failed' || state === 'succeeded';
}

function boundedLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError('production run page limit must be a positive integer');
  }
  return Math.min(limit, MAX_PAGE_LIMIT);
}

function cursorOffset(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const offset = Number(cursor);
  if (!Number.isInteger(offset) || offset < 0) {
    throw new RangeError('production run cursor is invalid');
  }
  return offset;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isProductionRunRecord(value: unknown): value is ProductionRunRecordV1 {
  if (!isRecord(value)) return false;
  return (
    value.recordVersion === 1 &&
    typeof value.runId === 'string' &&
    typeof value.workflowId === 'string' &&
    typeof value.workflowVersion === 'string' &&
    typeof value.projectRevision === 'string' &&
    typeof value.state === 'string' &&
    typeof value.checkpointRevision === 'number' &&
    Array.isArray(value.events) &&
    Array.isArray(value.approvals) &&
    Array.isArray(value.nodes) &&
    typeof value.createdSeq === 'number' &&
    typeof value.updatedSeq === 'number'
  );
}

function isRunKeyRecord(value: unknown): value is BrowserProductionRunDatabase['runKeys'][number] {
  return isRecord(value) && typeof value.key === 'string' && typeof value.runId === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
