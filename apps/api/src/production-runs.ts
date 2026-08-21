import type { Pool, PoolClient } from 'pg';
import { ControlPlaneError, type Actor } from './control-plane.js';

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
  readonly eventVersion: 1;
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
  readonly approvalVersion: 1;
  readonly approvalId: string;
  readonly nodeId: string;
  readonly kind: string;
  readonly prompt: string;
  readonly requestPayload?: unknown;
  readonly state: ProductionApprovalStateV1;
  readonly requestedSeq: number;
  readonly respondedSeq?: number;
  readonly responseRef?: string;
  readonly response?: unknown;
  readonly rejectionReason?: string;
  readonly authority?: ProductionRunAuthority;
}

export interface ProductionRunPublicLogEntryV1 {
  readonly seq: number;
  readonly nodeId: string;
  readonly attempt: number;
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly message: string;
}

export interface ProductionRunNodeProjectionV1 {
  readonly nodeId: string;
  readonly type: string;
  readonly category: string;
  readonly state: string;
  readonly attempts: number;
  readonly deterministic: boolean;
  readonly reused: boolean;
  readonly failureCode?: string;
  readonly pendingApprovalId?: string;
  readonly logs: readonly ProductionRunPublicLogEntryV1[];
  readonly artifactIds: readonly string[];
}

export interface ProductionRunRecordV1 {
  readonly recordVersion: 1;
  readonly runId: string;
  readonly workflowId: string;
  readonly workflowVersion: string;
  readonly projectRevision: string;
  readonly state: ProductionRunStateV1;
  readonly checkpointRevision: number;
  readonly checkpoint?: unknown;
  readonly links: ProductionRunLinksV1;
  readonly events: readonly ProductionRunEventV1[];
  readonly approvals: readonly ProductionApprovalV1[];
  readonly nodes: readonly ProductionRunNodeProjectionV1[];
  readonly createdSeq: number;
  readonly updatedSeq: number;
}

export interface CreateProductionRunInput {
  readonly runKey: string;
  readonly record: ProductionRunRecordV1;
  readonly authority: ProductionRunAuthority;
  readonly approvalExpiresAt?: number;
  readonly now?: number;
}

export interface ListProductionRunsOptions {
  readonly limit?: number;
  readonly cursor?: string;
  readonly state?: ProductionRunStateV1;
}

export interface ProductionRunPage {
  readonly runs: readonly ProductionRunRecordV1[];
  readonly nextCursor?: string;
}

export interface RespondToProductionApprovalInput {
  readonly approvalId: string;
  readonly approved: boolean;
  readonly responseRef: string;
  readonly response?: unknown;
  readonly rejectionReason?: string;
  readonly authority: ProductionRunAuthority;
  readonly expectedUpdatedSeq?: number;
  readonly now?: number;
}

export interface CancelProductionRunInput {
  readonly authority: ProductionRunAuthority;
  readonly expectedUpdatedSeq?: number;
  readonly now?: number;
}

export interface ProductionApprovalResponseResult {
  readonly record: ProductionRunRecordV1;
  readonly duplicate: boolean;
}

export interface ProductionRunStore {
  createProductionRun(
    actor: Actor,
    projectId: string,
    input: CreateProductionRunInput,
  ): Promise<ProductionRunRecordV1>;
  listProductionRuns(
    actor: Actor,
    projectId: string,
    options?: ListProductionRunsOptions,
  ): Promise<ProductionRunPage>;
  getProductionRun(actor: Actor, projectId: string, runId: string): Promise<ProductionRunRecordV1>;
  respondToProductionApproval(
    actor: Actor,
    projectId: string,
    runId: string,
    input: RespondToProductionApprovalInput,
  ): Promise<ProductionApprovalResponseResult>;
  cancelProductionRun(
    actor: Actor,
    projectId: string,
    runId: string,
    input: CancelProductionRunInput,
  ): Promise<ProductionRunRecordV1>;
}

interface ProductionRunRow {
  readonly id: string;
  readonly record: unknown;
}

interface ApprovalExpiryRow {
  readonly state: ProductionApprovalStateV1;
  readonly expires_at: Date | null;
}

const MAX_RUN_RECORD_BYTES = 1_000_000;
const MAX_LOGS_PER_NODE = 50;
const MAX_LOG_MESSAGE_LENGTH = 1_000;
const MAX_PUBLIC_STRING_LENGTH = 4_096;
const RAW_MEDIA_BASE64_MIN_LENGTH = 128;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const FORBIDDEN_KEYS = new Set([
  'base64',
  'bytesData',
  'filePath',
  'localPath',
  'mediaBase64',
  'mediaBytes',
  'rawMedia',
]);
const PATH_OR_MEDIA_LEAK =
  /[A-Za-z]:\\|\\\\|file:\/\/|(?:^|[\s"'([])\/(?:[^/\s]+\/)+[^/\s]+|https?:\/\/|data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,/i;

export class PostgresProductionRunStore implements ProductionRunStore {
  constructor(private readonly pool: Pool) {}

  async createProductionRun(
    actor: Actor,
    projectId: string,
    input: CreateProductionRunInput,
  ): Promise<ProductionRunRecordV1> {
    assertActor(actor);
    validateOpaque(projectId, 'project id');
    validateOpaque(input.runKey, 'run key');
    validateAuthority(actor, input.authority);
    validateRunRecord(projectId, input.record);
    requireCreationAuthority(input.record, input.authority);
    if (input.approvalExpiresAt !== undefined && input.approvalExpiresAt <= 0)
      throw new ControlPlaneError('REQUEST_INVALID', 'approval expiry is invalid');
    const now = new Date(input.now ?? Date.now());
    return this.transaction(async (client) => {
      await ownedProject(client, actor, projectId);
      try {
        await client.query(
          `INSERT INTO production_runs
             (id, project_id, run_key, workflow_id, workflow_version, project_revision, state,
              checkpoint_revision, record, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $10)`,
          [
            input.record.runId,
            projectId,
            input.runKey,
            input.record.workflowId,
            input.record.workflowVersion,
            input.record.projectRevision,
            input.record.state,
            input.record.checkpointRevision,
            JSON.stringify(input.record),
            now,
          ],
        );
      } catch (error) {
        throw databaseError(error, 'PRODUCTION_RUN_KEY_EXISTS', input.runKey);
      }
      await insertEvents(client, projectId, input.record, now);
      await upsertApprovals(
        client,
        projectId,
        input.record,
        input.approvalExpiresAt === undefined ? null : new Date(input.approvalExpiresAt),
      );
      return cloneRecord(input.record);
    });
  }

  async listProductionRuns(
    actor: Actor,
    projectId: string,
    options: ListProductionRunsOptions = {},
  ): Promise<ProductionRunPage> {
    assertActor(actor);
    validateOpaque(projectId, 'project id');
    const limit = options.limit ?? 25;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new ControlPlaneError('REQUEST_INVALID', 'limit must be between 1 and 100');
    if (options.cursor !== undefined) validateOpaque(options.cursor, 'cursor');
    if (options.state !== undefined) validateState(options.state);
    await ownedProject(this.pool, actor, projectId);
    const params: unknown[] = [projectId, options.cursor ?? '', limit + 1];
    let stateClause = '';
    if (options.state !== undefined) {
      params.push(options.state);
      stateClause = ` AND state = $${params.length}`;
    }
    const result = await this.pool.query<ProductionRunRow>(
      `SELECT id, record FROM production_runs
       WHERE project_id = $1 AND id > $2${stateClause}
       ORDER BY id LIMIT $3`,
      params,
    );
    const rows = result.rows.slice(0, limit);
    const next = result.rows.length > limit ? rows.at(-1)?.id : undefined;
    return {
      runs: rows.map((row) => productionRunOf(row.record)),
      ...(next === undefined ? {} : { nextCursor: next }),
    };
  }

  async getProductionRun(
    actor: Actor,
    projectId: string,
    runId: string,
  ): Promise<ProductionRunRecordV1> {
    assertActor(actor);
    validateOpaque(projectId, 'project id');
    validateOpaque(runId, 'run id');
    await ownedProject(this.pool, actor, projectId);
    const result = await this.pool.query<ProductionRunRow>(
      'SELECT id, record FROM production_runs WHERE project_id = $1 AND id = $2',
      [projectId, runId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new ControlPlaneError('PRODUCTION_RUN_NOT_FOUND', runId);
    return productionRunOf(row.record);
  }

  async respondToProductionApproval(
    actor: Actor,
    projectId: string,
    runId: string,
    input: RespondToProductionApprovalInput,
  ): Promise<ProductionApprovalResponseResult> {
    assertActor(actor);
    validateOpaque(projectId, 'project id');
    validateOpaque(runId, 'run id');
    validateOpaque(input.approvalId, 'approval id');
    validateOpaque(input.responseRef, 'response ref');
    validateAuthority(actor, input.authority);
    const now = input.now ?? Date.now();
    return this.transaction(async (client) => {
      await ownedProject(client, actor, projectId);
      const current = await loadForUpdate(client, projectId, runId);
      requireRunAuthority(current, input.authority);
      const replay = applyApprovalResponse(current, input);
      if (
        input.expectedUpdatedSeq !== undefined &&
        current.updatedSeq !== input.expectedUpdatedSeq
      ) {
        if (replay.ok && replay.duplicate) return { record: current, duplicate: true };
        throw new ControlPlaneError(
          'REVISION_CONFLICT',
          `expected ${String(input.expectedUpdatedSeq)}, found ${String(current.updatedSeq)}`,
        );
      }
      const expiry = await client.query<ApprovalExpiryRow>(
        `SELECT state, expires_at FROM production_approvals
         WHERE project_id = $1 AND run_id = $2 AND approval_id = $3`,
        [projectId, runId, input.approvalId],
      );
      const expiryRow = expiry.rows[0];
      if (expiryRow === undefined)
        throw new ControlPlaneError('APPROVAL_NOT_FOUND', input.approvalId);
      if (
        expiryRow.state === 'pending' &&
        expiryRow.expires_at !== null &&
        expiryRow.expires_at.getTime() <= now
      ) {
        throw new ControlPlaneError('APPROVAL_EXPIRED', input.approvalId);
      }
      const applied = replay;
      if (!applied.ok) {
        throw new ControlPlaneError(
          applied.reason === 'approval-not-found' ? 'APPROVAL_NOT_FOUND' : 'APPROVAL_CONFLICT',
          input.approvalId,
        );
      }
      if (applied.duplicate) return { record: current, duplicate: true };
      await replaceRecord(client, projectId, applied.record, new Date(now), current.updatedSeq);
      await insertNewEvents(client, projectId, current, applied.record, new Date(now));
      await upsertApprovals(client, projectId, applied.record, null);
      return { record: applied.record, duplicate: false };
    });
  }

  async cancelProductionRun(
    actor: Actor,
    projectId: string,
    runId: string,
    input: CancelProductionRunInput,
  ): Promise<ProductionRunRecordV1> {
    assertActor(actor);
    validateOpaque(projectId, 'project id');
    validateOpaque(runId, 'run id');
    validateAuthority(actor, input.authority);
    const now = input.now ?? Date.now();
    return this.transaction(async (client) => {
      await ownedProject(client, actor, projectId);
      const current = await loadForUpdate(client, projectId, runId);
      if (
        input.expectedUpdatedSeq !== undefined &&
        current.updatedSeq !== input.expectedUpdatedSeq
      ) {
        throw new ControlPlaneError(
          'REVISION_CONFLICT',
          `expected ${String(input.expectedUpdatedSeq)}, found ${String(current.updatedSeq)}`,
        );
      }
      if (current.state === 'canceled') return current;
      if (current.state === 'failed' || current.state === 'succeeded')
        throw new ControlPlaneError('PRODUCTION_RUN_NOT_CANCELABLE', runId);
      const next = appendEvent(current, {
        type: 'run.canceled',
        state: 'canceled',
        actor: input.authority,
        message: 'production run canceled',
      });
      await replaceRecord(client, projectId, next, new Date(now), current.updatedSeq);
      await insertNewEvents(client, projectId, current, next, new Date(now));
      return next;
    });
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

function applyApprovalResponse(
  record: ProductionRunRecordV1,
  input: RespondToProductionApprovalInput,
):
  | { readonly ok: true; readonly duplicate: boolean; readonly record: ProductionRunRecordV1 }
  | { readonly ok: false; readonly reason: 'approval-not-found' | 'approval-conflict' } {
  const approval = record.approvals.find((candidate) => candidate.approvalId === input.approvalId);
  if (approval === undefined) return { ok: false, reason: 'approval-not-found' };
  const nextState = input.approved ? 'approved' : 'rejected';
  if (approval.state !== 'pending') {
    if (
      approval.state === nextState &&
      approval.responseRef === input.responseRef &&
      jsonEqual(approval.response, input.response) &&
      approval.rejectionReason === input.rejectionReason
    ) {
      return { ok: true, duplicate: true, record };
    }
    return { ok: false, reason: 'approval-conflict' };
  }
  const seq = (record.events.at(-1)?.seq ?? 0) + 1;
  const updatedApproval: ProductionApprovalV1 = {
    ...approval,
    state: nextState,
    respondedSeq: seq,
    responseRef: input.responseRef,
    ...(input.response === undefined ? {} : { response: input.response }),
    ...(input.rejectionReason === undefined ? {} : { rejectionReason: input.rejectionReason }),
    authority: input.authority,
  };
  const event: ProductionRunEventV1 = {
    eventVersion: 1,
    seq,
    type: 'approval.responded',
    state: record.state,
    actor: input.authority,
    nodeId: approval.nodeId,
    approvalId: approval.approvalId,
    checkpointRevision: record.checkpointRevision,
    message: nextState,
  };
  const approvals = record.approvals.map((candidate) =>
    candidate.approvalId === approval.approvalId ? updatedApproval : candidate,
  );
  const nodes = record.nodes.map((candidate) => {
    if (candidate.pendingApprovalId !== approval.approvalId) return candidate;
    const { pendingApprovalId: _pendingApprovalId, ...withoutPendingApproval } = candidate;
    return withoutPendingApproval;
  });
  return {
    ok: true,
    duplicate: false,
    record: {
      ...record,
      approvals,
      nodes,
      events: [...record.events, event],
      updatedSeq: seq,
    },
  };
}

function appendEvent(
  record: ProductionRunRecordV1,
  input: Omit<ProductionRunEventV1, 'eventVersion' | 'seq' | 'checkpointRevision'> & {
    readonly checkpointRevision?: number;
  },
): ProductionRunRecordV1 {
  const seq = (record.events.at(-1)?.seq ?? 0) + 1;
  return {
    ...record,
    state: input.state,
    events: [
      ...record.events,
      {
        eventVersion: 1,
        seq,
        type: input.type,
        state: input.state,
        ...(input.actor === undefined ? {} : { actor: input.actor }),
        ...(input.nodeId === undefined ? {} : { nodeId: input.nodeId }),
        ...(input.approvalId === undefined ? {} : { approvalId: input.approvalId }),
        checkpointRevision: input.checkpointRevision ?? record.checkpointRevision,
        ...(input.failureCode === undefined ? {} : { failureCode: input.failureCode }),
        ...(input.message === undefined ? {} : { message: input.message }),
      },
    ],
    updatedSeq: seq,
  };
}

async function ownedProject(
  client: Pool | PoolClient,
  actor: Actor,
  projectId: string,
): Promise<void> {
  const project = await client.query<{ readonly id: string }>(
    'SELECT id FROM projects WHERE id = $1 AND owner_id = $2',
    [projectId, actor.id],
  );
  if (project.rows[0] === undefined) throw new ControlPlaneError('PROJECT_NOT_FOUND', projectId);
}

async function loadForUpdate(
  client: PoolClient,
  projectId: string,
  runId: string,
): Promise<ProductionRunRecordV1> {
  const result = await client.query<ProductionRunRow>(
    'SELECT id, record FROM production_runs WHERE project_id = $1 AND id = $2 FOR UPDATE',
    [projectId, runId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new ControlPlaneError('PRODUCTION_RUN_NOT_FOUND', runId);
  return productionRunOf(row.record);
}

async function replaceRecord(
  client: PoolClient,
  projectId: string,
  record: ProductionRunRecordV1,
  now: Date,
  previousUpdatedSeq: number,
): Promise<void> {
  validateRunRecord(projectId, record);
  const result = await client.query(
    `UPDATE production_runs
     SET state = $3, checkpoint_revision = $4, record = $5::jsonb, updated_at = $6
     WHERE project_id = $1 AND id = $2 AND (record->>'updatedSeq')::integer = $7`,
    [
      projectId,
      record.runId,
      record.state,
      record.checkpointRevision,
      JSON.stringify(record),
      now,
      previousUpdatedSeq,
    ],
  );
  if (result.rowCount !== 1)
    throw new ControlPlaneError('REVISION_CONFLICT', 'production run changed concurrently');
}

async function insertEvents(
  client: PoolClient,
  projectId: string,
  record: ProductionRunRecordV1,
  now: Date,
): Promise<void> {
  for (const event of record.events) {
    await client.query(
      `INSERT INTO production_run_events
         (run_id, project_id, seq, type, state, event, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [record.runId, projectId, event.seq, event.type, event.state, JSON.stringify(event), now],
    );
  }
}

async function insertNewEvents(
  client: PoolClient,
  projectId: string,
  previous: ProductionRunRecordV1,
  next: ProductionRunRecordV1,
  now: Date,
): Promise<void> {
  const previousSeqs = new Set(previous.events.map((event) => event.seq));
  for (const event of next.events) {
    if (previousSeqs.has(event.seq)) continue;
    await client.query(
      `INSERT INTO production_run_events
         (run_id, project_id, seq, type, state, event, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [next.runId, projectId, event.seq, event.type, event.state, JSON.stringify(event), now],
    );
  }
}

async function upsertApprovals(
  client: PoolClient,
  projectId: string,
  record: ProductionRunRecordV1,
  expiresAt: Date | null,
): Promise<void> {
  for (const approval of record.approvals) {
    await client.query(
      `INSERT INTO production_approvals
         (run_id, project_id, approval_id, node_id, state, approval, requested_seq, responded_seq, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
       ON CONFLICT (run_id, approval_id) DO UPDATE
       SET state = EXCLUDED.state,
           approval = EXCLUDED.approval,
           requested_seq = EXCLUDED.requested_seq,
           responded_seq = EXCLUDED.responded_seq,
           expires_at = COALESCE(production_approvals.expires_at, EXCLUDED.expires_at)`,
      [
        record.runId,
        projectId,
        approval.approvalId,
        approval.nodeId,
        approval.state,
        JSON.stringify(approval),
        approval.requestedSeq,
        approval.respondedSeq ?? null,
        expiresAt,
      ],
    );
  }
}

function productionRunOf(value: unknown): ProductionRunRecordV1 {
  const record = value as ProductionRunRecordV1;
  validateRunRecord(undefined, record);
  return cloneRecord(record);
}

function validateRunRecord(
  projectId: string | undefined,
  value: ProductionRunRecordV1,
): asserts value is ProductionRunRecordV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new ControlPlaneError(
      'PRODUCTION_RUN_INVALID',
      'production run record must be an object',
    );
  if (value.recordVersion !== 1) invalidRun('record version is invalid');
  validateOpaque(value.runId, 'run id');
  validateOpaque(value.workflowId, 'workflow id');
  validateSafeToken(value.workflowVersion, 'workflow version');
  validateSafeToken(value.projectRevision, 'project revision');
  validateState(value.state);
  if (!Number.isSafeInteger(value.checkpointRevision) || value.checkpointRevision < 0)
    invalidRun('checkpoint revision is invalid');
  if (!Array.isArray(value.events) || value.events.length === 0) invalidRun('events are required');
  if (!Array.isArray(value.approvals)) invalidRun('approvals must be an array');
  if (!Array.isArray(value.nodes)) invalidRun('nodes must be an array');
  if (!Number.isSafeInteger(value.createdSeq) || value.createdSeq < 1)
    invalidRun('created sequence is invalid');
  if (!Number.isSafeInteger(value.updatedSeq) || value.updatedSeq < value.createdSeq)
    invalidRun('updated sequence is invalid');
  validateLinks(value.links);
  validateEvents(value);
  validateApprovals(value);
  validateNodes(value);
  rejectUnsafePayload(value);
  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (bytes > MAX_RUN_RECORD_BYTES) invalidRun('production run record exceeds the size limit');
  void projectId;
}

function validateEvents(record: ProductionRunRecordV1): void {
  let previous = 0;
  for (const event of record.events) {
    if (event.eventVersion !== 1) invalidRun('event version is invalid');
    if (!Number.isSafeInteger(event.seq) || event.seq <= previous)
      invalidRun('events must be strictly ordered');
    previous = event.seq;
    validateEventType(event.type);
    validateState(event.state);
    if (event.actor !== undefined) validateAuthorityShape(event.actor);
    if (event.nodeId !== undefined) validateOpaque(event.nodeId, 'node id');
    if (event.approvalId !== undefined) validateOpaque(event.approvalId, 'approval id');
    if (
      event.checkpointRevision !== undefined &&
      (!Number.isSafeInteger(event.checkpointRevision) || event.checkpointRevision < 0)
    ) {
      invalidRun('event checkpoint revision is invalid');
    }
    if (event.failureCode !== undefined) validateSafeString(event.failureCode, 'failure code');
    if (event.message !== undefined) validateSafeString(event.message, 'event message');
  }
  if (record.updatedSeq !== previous) invalidRun('updated sequence must match the last event');
}

function validateApprovals(record: ProductionRunRecordV1): void {
  const seen = new Set<string>();
  for (const approval of record.approvals) {
    if (approval.approvalVersion !== 1) invalidRun('approval version is invalid');
    validateOpaque(approval.approvalId, 'approval id');
    validateOpaque(approval.nodeId, 'node id');
    validateSafeString(approval.kind, 'approval kind');
    validateSafeString(approval.prompt, 'approval prompt');
    if (
      approval.state !== 'pending' &&
      approval.state !== 'approved' &&
      approval.state !== 'rejected'
    ) {
      invalidRun('approval state is invalid');
    }
    if (!Number.isSafeInteger(approval.requestedSeq) || approval.requestedSeq < 1)
      invalidRun('approval requested sequence is invalid');
    if (
      approval.respondedSeq !== undefined &&
      (!Number.isSafeInteger(approval.respondedSeq) ||
        approval.respondedSeq <= approval.requestedSeq)
    ) {
      invalidRun('approval responded sequence is invalid');
    }
    if (approval.responseRef !== undefined) validateOpaque(approval.responseRef, 'response ref');
    if (approval.rejectionReason !== undefined)
      validateSafeString(approval.rejectionReason, 'rejection reason');
    if (approval.authority !== undefined) validateAuthorityShape(approval.authority);
    if (seen.has(approval.approvalId)) invalidRun('approval IDs must be unique');
    seen.add(approval.approvalId);
  }
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateNodes(record: ProductionRunRecordV1): void {
  for (const node of record.nodes) {
    validateOpaque(node.nodeId, 'node id');
    validateSafeString(node.type, 'node type');
    validateSafeString(node.category, 'node category');
    validateSafeString(node.state, 'node state');
    if (!Number.isSafeInteger(node.attempts) || node.attempts < 0)
      invalidRun('node attempts are invalid');
    if (typeof node.deterministic !== 'boolean' || typeof node.reused !== 'boolean')
      invalidRun('node booleans are invalid');
    if (node.failureCode !== undefined) validateSafeString(node.failureCode, 'failure code');
    if (node.pendingApprovalId !== undefined) validateOpaque(node.pendingApprovalId, 'approval id');
    if (!Array.isArray(node.logs) || node.logs.length > MAX_LOGS_PER_NODE)
      invalidRun('node public logs exceed the size limit');
    if (!Array.isArray(node.artifactIds) || node.artifactIds.length > 100)
      invalidRun('node artifact IDs exceed the size limit');
    for (const entry of node.logs) validateLog(entry);
    for (const artifactId of node.artifactIds) validateOpaque(artifactId, 'artifact id');
  }
}

function validateLog(entry: ProductionRunPublicLogEntryV1): void {
  if (!Number.isSafeInteger(entry.seq) || entry.seq < 1) invalidRun('log sequence is invalid');
  validateOpaque(entry.nodeId, 'node id');
  if (!Number.isSafeInteger(entry.attempt) || entry.attempt < 1)
    invalidRun('log attempt is invalid');
  if (
    entry.level !== 'debug' &&
    entry.level !== 'info' &&
    entry.level !== 'warn' &&
    entry.level !== 'error'
  )
    invalidRun('log level is invalid');
  if (typeof entry.message !== 'string' || entry.message.length > MAX_LOG_MESSAGE_LENGTH)
    invalidRun('log message exceeds the size limit');
  validateSafeString(entry.message, 'log message');
}

function validateLinks(links: ProductionRunLinksV1): void {
  if (links === null || typeof links !== 'object' || Array.isArray(links))
    invalidRun('links are invalid');
  for (const value of [links.jobId, links.providerRunId, links.reportId]) {
    if (value !== undefined) validateOpaque(value, 'link id');
  }
  if (links.artifactIds !== undefined) {
    if (!Array.isArray(links.artifactIds) || links.artifactIds.length > 100)
      invalidRun('artifact links are invalid');
    for (const artifactId of links.artifactIds) validateOpaque(artifactId, 'artifact id');
  }
}

function rejectUnsafePayload(value: unknown, key = ''): void {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    if (value.length > MAX_PUBLIC_STRING_LENGTH)
      invalidRun(`${key || 'string'} exceeds the size limit`);
    if (PATH_OR_MEDIA_LEAK.test(value) || looksLikeRawMediaPayload(value))
      invalidRun('production run record must not contain paths, URLs, or raw media');
    return;
  }
  if (typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) rejectUnsafePayload(item, key);
    return;
  }
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(entryKey))
      invalidRun('production run record must not contain raw media payload fields');
    rejectUnsafePayload(entryValue, entryKey);
  }
}

function requireCreationAuthority(
  record: ProductionRunRecordV1,
  authority: ProductionRunAuthority,
): void {
  const firstActor = record.events[0]?.actor;
  if (firstActor === undefined || !sameAuthority(firstActor, authority)) {
    throw new ControlPlaneError(
      'AUTHORITY_REQUIRED',
      'production run creation must include explicit matching authority',
    );
  }
  for (const event of record.events) {
    if (event.actor !== undefined && !sameAuthority(event.actor, authority)) {
      throw new ControlPlaneError(
        'AUTHORITY_REQUIRED',
        'production run events must not mix authorities',
      );
    }
  }
  for (const approval of record.approvals) {
    if (approval.authority !== undefined && !sameAuthority(approval.authority, authority)) {
      throw new ControlPlaneError(
        'AUTHORITY_REQUIRED',
        'production run approvals must not mix authorities',
      );
    }
  }
}

function requireRunAuthority(
  record: ProductionRunRecordV1,
  authority: ProductionRunAuthority,
): void {
  const runAuthority = record.events[0]?.actor;
  if (runAuthority === undefined || !sameAuthority(runAuthority, authority)) {
    throw new ControlPlaneError(
      'AUTHORITY_INVALID',
      'authority must match the production run authority',
    );
  }
}

function validateAuthority(actor: Actor, authority: ProductionRunAuthority): void {
  validateAuthorityShape(authority);
  if (authority.principalId !== actor.id || authority.role === 'system')
    throw new ControlPlaneError(
      'AUTHORITY_INVALID',
      'authority must match the authenticated actor',
    );
}

function validateAuthorityShape(authority: ProductionRunAuthority): void {
  validateOpaque(authority.principalId, 'principal id');
  if (
    authority.role !== 'system' &&
    authority.role !== 'owner' &&
    authority.role !== 'operator' &&
    authority.role !== 'reviewer'
  ) {
    invalidRun('authority role is invalid');
  }
  if (authority.displayName !== undefined)
    validateSafeString(authority.displayName, 'display name');
}

function validateEventType(value: ProductionRunEventTypeV1): void {
  if (
    value !== 'run.queued' &&
    value !== 'run.started' &&
    value !== 'run.checkpointed' &&
    value !== 'run.parked' &&
    value !== 'run.failed' &&
    value !== 'run.canceled' &&
    value !== 'run.succeeded' &&
    value !== 'approval.requested' &&
    value !== 'approval.responded'
  ) {
    invalidRun('event type is invalid');
  }
}

function validateState(value: ProductionRunStateV1): void {
  if (
    value !== 'queued' &&
    value !== 'running' &&
    value !== 'parked' &&
    value !== 'failed' &&
    value !== 'canceled' &&
    value !== 'succeeded'
  ) {
    invalidRun('production run state is invalid');
  }
}

function validateOpaque(value: string, label: string): void {
  if (typeof value !== 'string' || !OPAQUE_ID.test(value))
    throw new ControlPlaneError('PRODUCTION_RUN_INVALID', `${label} must be opaque`);
}

function validateSafeToken(value: string, label: string): void {
  if (typeof value !== 'string' || !SAFE_TOKEN.test(value))
    throw new ControlPlaneError('PRODUCTION_RUN_INVALID', `${label} is invalid`);
}

function validateSafeString(value: string, label: string): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PUBLIC_STRING_LENGTH)
    throw new ControlPlaneError('PRODUCTION_RUN_INVALID', `${label} is invalid`);
  if (PATH_OR_MEDIA_LEAK.test(value) || looksLikeRawMediaPayload(value))
    throw new ControlPlaneError(
      'PRODUCTION_RUN_INVALID',
      `${label} must not contain a path, URL, or raw media`,
    );
}

function sameAuthority(left: ProductionRunAuthority, right: ProductionRunAuthority): boolean {
  return left.principalId === right.principalId && left.role === right.role;
}

function looksLikeRawMediaPayload(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length >= RAW_MEDIA_BASE64_MIN_LENGTH &&
    trimmed.length % 4 !== 1 &&
    /^[A-Za-z0-9+/_-]+={0,2}$/.test(trimmed)
  );
}

function cloneRecord(record: ProductionRunRecordV1): ProductionRunRecordV1 {
  return JSON.parse(JSON.stringify(record)) as ProductionRunRecordV1;
}

function assertActor(actor: Actor): void {
  if (actor.id.length === 0)
    throw new ControlPlaneError('AUTH_REQUIRED', 'actor identity required');
}

function invalidRun(message: string): never {
  throw new ControlPlaneError('PRODUCTION_RUN_INVALID', message);
}

function databaseError(error: unknown, duplicateCode: string, id: string): ControlPlaneError {
  if (isPostgresError(error) && error.code === '23505')
    return new ControlPlaneError(duplicateCode, id);
  if (error instanceof ControlPlaneError) return error;
  return new ControlPlaneError('DATABASE_ERROR', 'durable production-run operation failed');
}

function isPostgresError(value: unknown): value is { readonly code: string } {
  return (
    value !== null && typeof value === 'object' && 'code' in value && typeof value.code === 'string'
  );
}
