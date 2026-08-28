import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { validateProjectDocumentV2 } from '@joy-media/project-schema';
import {
  isWorkerJobType,
  validateWorkerJobV1,
  validateWorkerReceiptForJob,
  workerCanRunJob,
  WORKER_JOB_TYPES,
  WORKER_PROTOCOL_VERSION,
} from '@joy-media/job-protocol';
import type {
  RenderInspectPayload,
  VideoReferenceAnalyzeReceipt,
  WorkerJobType,
  WorkerJobV1,
} from '@joy-media/job-protocol';
import {
  ControlPlaneError,
  EXPLICIT_SHARED_LIBRARY_OWNER_ID,
  EXPLICIT_SHARED_LIBRARY_PROJECT_ID,
  type AssetLocationRecord,
  type AssetRegistration,
  type Actor,
  type AssetThumbnailReceipt,
  type CloudDerivativeRegistration,
  type ControlPlane,
  type LocalDerivativeRegistration,
  type MediaAssetRecord,
  type MediaDerivativeRecord,
  type RenderArtifactRecord,
  type WorkerRenderArtifactRegistration,
  type Job,
  type JobEvent,
  type LocalGpuWorkerReceipt,
  type WorkerResultReceipt,
  type ProjectMetadata,
  type SemanticIndexWorkerReceipt,
  type WorkerPairingOffer,
  type WorkerRecord,
  type WorkerSession,
  validateAssetRegistration,
  validateAssetTags,
  validateCloudDerivativeRegistration,
  validateLocalDerivativeRegistration,
  validateSortName,
  validateWorkerRenderArtifactRegistration,
} from './control-plane.js';
import { POSTGRES_SCHEMA } from './postgres-schema.js';
import type { PrivateObjectStore } from './private-object-store.js';
import {
  PostgresProductionRunStore,
  type CancelProductionRunInput,
  type CreateProductionRunInput,
  type ListProductionRunsOptions,
  type ProductionApprovalResponseResult,
  type ProductionRunPage,
  type ProductionRunRecordV1,
  type ProductionRunStore,
  type RespondToProductionApprovalInput,
} from './production-runs.js';

const WORKER_ATTEMPT_BUDGET_EXHAUSTED = 'Worker attempt budget exhausted';
import {
  documentHash,
  rewriteRecoveredDocument,
  revisionConflict,
  validateAppendInput,
  validateBaseRevision,
  validateIdempotencyKey,
  validateRecoveredCopyInput,
  validateRevisionNumber,
  type AppendProjectRevisionInput,
  type CreateRecoveredCopyInput,
  type ProjectDocumentV2,
  type ProjectDocumentSnapshotV2,
  type ProjectRevisionV1,
  type ProjectRevisionStore,
  type RecoveredCopy,
  type RecoveredCopyProvenance,
  type RestoreProjectRevisionInput,
} from './project-revisions.js';

const POSTGRES_SCHEMA_LOCK_ID = 1_245_665_613;
const UNSUPPORTED_JOB_ERROR =
  'Worker job type is no longer supported; enqueue a currently supported job';

async function acquireSchemaMigrationLock(client: PoolClient): Promise<void> {
  try {
    await client.query('SELECT pg_advisory_xact_lock($1)', [POSTGRES_SCHEMA_LOCK_ID]);
  } catch (error) {
    // pg-mem does not implement PostgreSQL advisory-lock functions. Real
    // PostgreSQL always provides this built-in, so only tolerate that exact
    // emulator limitation and surface every other migration failure.
    const message = error instanceof Error ? error.message : String(error);
    if (!/function\s+pg_advisory_xact_lock\b.*does not exist/iu.test(message)) throw error;
  }
}

async function retireUnsupportedActiveJobs(database: Pool | PoolClient): Promise<void> {
  const supportedTypeParameters = WORKER_JOB_TYPES.map((_, index) => `$${index + 2}`).join(', ');
  await database.query(
    `UPDATE jobs SET state = 'failed', lease_owner = NULL, lease_expires_at = NULL,
         cancel_requested = false, error = $1
     WHERE state IN ('queued', 'leased') AND type NOT IN (${supportedTypeParameters})`,
    [UNSUPPORTED_JOB_ERROR, ...WORKER_JOB_TYPES],
  );
}

interface ProjectRow {
  readonly id: string;
  readonly owner_id: string;
  readonly title: string;
  readonly revision: number;
  readonly asset_sync_enabled: boolean;
}

interface ProjectRevisionRow {
  readonly project_id: string;
  readonly revision: number;
  readonly base_revision: number;
  readonly idempotency_key: string;
  readonly operation: unknown;
  readonly document: unknown;
  readonly document_hash: string;
  readonly created_at: Date;
}

interface ProjectDocumentRow {
  readonly project_id: string;
  readonly revision: number;
  readonly document: unknown;
  readonly document_hash: string;
  readonly updated_at: Date;
}

interface ProjectRecoveryCopyRow {
  readonly source_project_id: string;
  readonly idempotency_key: string;
  readonly request_fingerprint: string;
  readonly recovered_project_id: string;
  readonly response: unknown;
  readonly created_at: Date;
}

interface WorkerRow {
  readonly id: string;
  readonly owner_id: string;
  readonly revoked_at: Date | null;
  readonly session_token_hash: string | null;
  readonly session_expires_at: Date | null;
  readonly capabilities: readonly string[];
  readonly local_asset_ids: readonly string[];
  readonly last_seen_at: Date | null;
}

interface PairingOfferRow {
  readonly worker_id: string;
  readonly pairing_code_hash: string;
  readonly owner_id: string | null;
  readonly expires_at: Date;
}

interface JobRow {
  readonly id: string;
  readonly project_id: string;
  readonly type: string;
  readonly asset_id: string | null;
  readonly job_payload: unknown;
  readonly job_requirements: unknown;
  readonly idempotency_key: string | null;
  readonly max_attempts: number | null;
  readonly state: Job['state'];
  readonly lease_owner: string | null;
  readonly lease_expires_at: Date | null;
  readonly progress: number;
  readonly cancel_requested: boolean;
  readonly asset_revoked: boolean;
  readonly result_kind: string | null;
  readonly result_sha256: string | null;
  readonly result_bytes: number | null;
  readonly result_ref: string | null;
  readonly result_worker_ref: string | null;
  readonly result_verified_at: Date | null;
  readonly result_asset_id: string | null;
  readonly result_local_ref: string | null;
  readonly result_mime_type: string | null;
  readonly result_width: number | null;
  readonly result_height: number | null;
  readonly result_receipt: unknown;
  readonly error: string | null;
}

interface MediaAssetRow {
  readonly id: string;
  readonly project_id: string;
  readonly kind: MediaAssetRecord['kind'];
  readonly display_name: string;
  readonly sha256: string;
  readonly byte_length: string | number;
  readonly descriptor: unknown;
  readonly locations: unknown;
  readonly tags: unknown;
  readonly sort_name: string | null;
  readonly created_at: Date;
}

interface MediaDerivativeRow {
  readonly id: string;
  readonly project_id: string;
  readonly asset_id: string;
  readonly kind: MediaDerivativeRecord['kind'];
  readonly profile: string;
  readonly sha256: string;
  readonly byte_length: string | number;
  readonly descriptor: unknown;
  readonly availability: MediaDerivativeRecord['availability'];
  readonly locations: unknown;
  readonly verified_at: Date;
}

interface AssetRevocationAuditRow {
  readonly revoke_id: string | number;
  readonly project_id: string;
  readonly asset_id: string;
  readonly actor_id: string;
  readonly asset_snapshot: unknown;
  readonly derivative_snapshot: unknown;
  readonly object_refs: unknown;
  readonly canceled_job_ids: unknown;
  readonly purge_state: 'pending' | 'complete' | 'failed';
  readonly purge_error: string | null;
  readonly requested_at: Date;
  readonly purged_at: Date | null;
  readonly updated_at: Date;
}

export interface AssetRevocationAudit {
  readonly revokeId: number;
  readonly projectId: string;
  readonly assetId: string;
  readonly actorId: string;
  readonly assetSnapshot: MediaAssetRecord;
  readonly derivativeSnapshot: readonly MediaDerivativeRecord[];
  readonly objectRefs: readonly string[];
  readonly canceledJobIds: readonly string[];
  readonly purgeState: 'pending' | 'complete' | 'failed';
  readonly purgeError?: string;
  readonly requestedAt: string;
  readonly purgedAt?: string;
  readonly updatedAt: string;
}

interface RenderArtifactRow {
  readonly id: string;
  readonly project_id: string;
  readonly job_id: string;
  readonly output_ref: string;
  readonly sha256: string;
  readonly byte_length: string | number;
  readonly descriptor: unknown;
  readonly location: unknown;
  readonly verified_at: Date;
}

interface EventRow {
  readonly cursor: string | number;
  readonly job_id: string;
  readonly type: string;
  readonly created_at: Date;
}

export interface PostgresControlPlaneOptions {
  /** Test emulators may not implement PostgreSQL's queue-safe SKIP LOCKED. */
  readonly skipLocked?: boolean;
  /** Server-side object store used by post-commit asset revocation. */
  readonly privateObjectStore?: PrivateObjectStore;
}

/** Durable PostgreSQL implementation of the control-plane contract. */
export class PostgresControlPlane
  implements ControlPlane, ProductionRunStore, ProjectRevisionStore
{
  readonly #skipLocked: boolean;
  #privateObjectStore: PrivateObjectStore | undefined;
  readonly #productionRuns: PostgresProductionRunStore;

  constructor(
    private readonly pool: Pool,
    options: PostgresControlPlaneOptions = {},
  ) {
    this.#skipLocked = options.skipLocked ?? true;
    this.#privateObjectStore = options.privateObjectStore;
    this.#productionRuns = new PostgresProductionRunStore(pool);
  }

  async initialize(): Promise<void> {
    // Keep lightweight query-only adapters usable for schema inspection tests;
    // real pg Pools always expose connect and take the serialized path below.
    if (typeof this.pool.connect !== 'function') {
      await this.pool.query(POSTGRES_SCHEMA);
      await this.ensureAssetRevocationPrimaryKey();
      await retireUnsupportedActiveJobs(this.pool);
      return;
    }
    await this.transaction(async (client) => {
      await acquireSchemaMigrationLock(client);
      await client.query(POSTGRES_SCHEMA);
      await this.ensureAssetRevocationPrimaryKey(client);
      await retireUnsupportedActiveJobs(client);
    });
  }

  private async ensureAssetRevocationPrimaryKey(
    database: Pool | PoolClient = this.pool,
  ): Promise<void> {
    let result: { rows: readonly { indexname: string; indexdef: string }[] };
    try {
      result = await database.query<{
        readonly indexname: string;
        readonly indexdef: string;
      }>(
        `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = current_schema() AND tablename = 'asset_revocation_audits'`,
      );
    } catch (error) {
      // pg-mem does not expose PostgreSQL's catalog views. Fresh installs
      // already have the correct primary key, so there is nothing to migrate.
      if (
        error instanceof Error &&
        /(relation|table) [^ ]*pg_indexes[^ ]* does not exist/i.test(error.message)
      ) {
        return;
      }
      throw error;
    }
    const primaryIndexes = result.rows.filter((row) => /_pkey$/i.test(row.indexname));
    const actual = primaryIndexes.find((row) => /revoke_id/i.test(row.indexdef));
    const legacy = primaryIndexes.find((row) => !/revoke_id/i.test(row.indexdef));
    if (legacy !== undefined) {
      await database.query(
        `ALTER TABLE asset_revocation_audits DROP CONSTRAINT "${legacy.indexname.replace(/"/g, '""')}"`,
      );
    }
    if (actual === undefined) {
      try {
        await database.query(
          'ALTER TABLE asset_revocation_audits ADD CONSTRAINT asset_revocation_audits_revoke_id_pkey PRIMARY KEY (revoke_id)',
        );
      } catch (error) {
        // Some test emulators do not expose pg_constraint rows. If they still
        // report an existing primary key, preserve it rather than replacing it.
        if (!(error instanceof Error) || !/already has a primary key/i.test(error.message))
          throw error;
      }
    }
  }

  /** Bind the API's server-only store when the HTTP transport owns construction. */
  setPrivateObjectStore(store: PrivateObjectStore): void {
    this.#privateObjectStore = store;
  }

  /** Record a server-upload ref before bytes are written, so cleanup failures remain durable. */
  async stagePrivateObjectReference(
    actor: Actor,
    projectId: string,
    assetId: string,
    objectKind: 'original' | 'derivative' | 'artifact',
    objectRef: string,
  ): Promise<void> {
    await this.transaction(async (client) => {
      await this.asset(actor, projectId, assetId, client);
      await lockAssetForJob(client, projectId, assetId);
      await insertCleanupReference(client, projectId, assetId, undefined, objectKind, objectRef);
    });
  }

  async stageWorkerPrivateObjectReference(
    workerId: string,
    jobId: string,
    assetId: string | undefined,
    objectKind: 'derivative' | 'artifact',
    objectRef: string,
    now = Date.now(),
  ): Promise<void> {
    const result = await this.pool.query<{ readonly id: string }>(
      `INSERT INTO private_object_cleanup_refs
         (project_id, asset_id, job_id, object_kind, object_ref, state, created_at, updated_at)
       SELECT jobs.project_id, $3, jobs.id, $4, $5, 'pending', $6, $6
       FROM jobs WHERE jobs.id = $1 AND jobs.lease_owner = $2 AND jobs.state = 'leased'
       RETURNING id`,
      [jobId, workerId, assetId ?? null, objectKind, objectRef, new Date(now)],
    );
    if (result.rows[0] === undefined) throw new ControlPlaneError('LEASE_NOT_OWNED', jobId);
  }

  async markPrivateObjectReferenceRegistered(objectRef: string): Promise<void> {
    await this.pool.query(
      `UPDATE private_object_cleanup_refs SET state = 'registered', last_error = NULL, updated_at = NOW()
       WHERE object_ref = $1 AND state = 'pending'`,
      [objectRef],
    );
  }

  async markPrivateObjectReferenceCleanupFailed(objectRef: string): Promise<void> {
    await this.pool.query(
      `UPDATE private_object_cleanup_refs SET state = 'pending', last_error = 'OBJECT_CLEANUP_FAILED', updated_at = NOW()
       WHERE object_ref = $1 AND state IN ('pending', 'registered')`,
      [objectRef],
    );
  }

  /** Bounded server-only retry seam for objects staged before a failed promote/cleanup. */
  async retryPendingObjectCleanup(limit = 100): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new TypeError('cleanup retry limit must be between 1 and 100');
    if (this.#privateObjectStore === undefined) return 0;
    const result = await this.pool.query<{ readonly id: string; readonly object_ref: string }>(
      `SELECT id, object_ref FROM private_object_cleanup_refs
       WHERE state = 'pending' ORDER BY updated_at, id LIMIT $1`,
      [limit],
    );
    let cleaned = 0;
    for (const row of result.rows) {
      try {
        await this.#privateObjectStore.remove(row.object_ref);
        await this.pool.query(
          `UPDATE private_object_cleanup_refs SET state = 'cleaned', last_error = NULL,
             cleaned_at = NOW(), updated_at = NOW() WHERE id = $1`,
          [row.id],
        );
        cleaned += 1;
      } catch {
        await this.pool.query(
          `UPDATE private_object_cleanup_refs SET last_error = 'OBJECT_CLEANUP_FAILED', updated_at = NOW()
           WHERE id = $1`,
          [row.id],
        );
      }
    }
    return cleaned;
  }

  async getProject(actor: Actor, id: string): Promise<ProjectMetadata> {
    return this.project(actor, id);
  }

  async getProjectDocument(actor: Actor, projectId: string): Promise<ProjectDocumentSnapshotV2> {
    await this.project(actor, projectId);
    const result = await this.pool.query<ProjectDocumentRow>(
      `SELECT project_id, revision, document, document_hash, updated_at
       FROM project_documents WHERE project_id = $1`,
      [projectId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new ControlPlaneError('DOCUMENT_NOT_FOUND', projectId);
    return {
      projectId: row.project_id,
      revision: row.revision,
      document: parseProjectDocument(row.document),
      documentHash: row.document_hash,
      updatedAt: row.updated_at.toISOString(),
    };
  }

  async appendProjectRevision(
    actor: Actor,
    projectId: string,
    input: AppendProjectRevisionInput,
  ): Promise<ProjectRevisionV1> {
    await this.project(actor, projectId);
    validateAppendInput(projectId, input);
    return this.transaction(async (client) => {
      await this.project(actor, projectId, client);
      // Lock before checking idempotency so concurrent identical retries see
      // the committed first revision instead of a stale head.
      await client.query('SELECT id FROM projects WHERE id = $1 FOR UPDATE', [projectId]);
      const priorResult = await client.query<ProjectRevisionRow>(
        `SELECT project_id, revision, base_revision, idempotency_key, operation, document, document_hash, created_at
         FROM project_revisions WHERE project_id = $1 AND idempotency_key = $2`,
        [projectId, input.idempotencyKey],
      );
      const prior = priorResult.rows[0];
      if (prior !== undefined) {
        const priorDocument = parseProjectDocument(prior.document);
        if (
          prior.base_revision !== input.baseRevision ||
          prior.document_hash !== documentHash(input.document) ||
          revisionKind(prior.operation) !== (input.operation ?? 'replace') ||
          revisionTarget(prior.operation) !== (input.targetRevision ?? undefined) ||
          revisionLabel(prior.operation) !== (input.label ?? '')
        )
          throw new ControlPlaneError(
            'IDEMPOTENCY_CONFLICT',
            'idempotency key was already used for another revision',
          );
        void priorDocument;
        return projectRevisionOf(prior);
      }
      const currentResult = await client.query<{ readonly revision: number }>(
        'SELECT revision FROM project_documents WHERE project_id = $1 FOR UPDATE',
        [projectId],
      );
      const currentRevision = currentResult.rows[0]?.revision ?? 0;
      if (currentRevision !== input.baseRevision)
        throw revisionConflict(input.baseRevision, currentRevision);
      const nextRevision = currentRevision + 1;
      const createdAt = new Date();
      const operation = {
        kind: input.operation ?? ('replace' as const),
        idempotencyKey: input.idempotencyKey,
        ...(input.label === undefined ? {} : { label: input.label }),
        ...(input.targetRevision === undefined ? {} : { targetRevision: input.targetRevision }),
      };
      const hash = documentHash(input.document);
      const inserted = await client.query<ProjectRevisionRow>(
        `INSERT INTO project_revisions
           (project_id, revision, base_revision, idempotency_key, operation, document, document_hash, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8)
         RETURNING project_id, revision, base_revision, idempotency_key, operation, document, document_hash, created_at`,
        [
          projectId,
          nextRevision,
          input.baseRevision,
          input.idempotencyKey,
          JSON.stringify(operation),
          JSON.stringify(input.document),
          hash,
          createdAt,
        ],
      );
      await client.query(
        `INSERT INTO project_documents (project_id, revision, document, document_hash, updated_at)
         VALUES ($1, $2, $3::jsonb, $4, $5)
         ON CONFLICT (project_id) DO UPDATE SET revision = EXCLUDED.revision,
           document = EXCLUDED.document, document_hash = EXCLUDED.document_hash, updated_at = EXCLUDED.updated_at`,
        [projectId, nextRevision, JSON.stringify(input.document), hash, createdAt],
      );
      return projectRevisionOf(requiredRow(inserted.rows[0], 'REVISION_CREATE_FAILED'));
    }).catch((error) => {
      if (isPostgresError(error) && error.code === '23505')
        throw new ControlPlaneError('IDEMPOTENCY_CONFLICT', 'idempotency key was already used');
      throw error;
    });
  }

  async getProjectRevision(
    actor: Actor,
    projectId: string,
    revision: number,
  ): Promise<ProjectRevisionV1> {
    await this.project(actor, projectId);
    validateRevisionNumber(revision);
    const result = await this.pool.query<ProjectRevisionRow>(
      `SELECT project_id, revision, base_revision, idempotency_key, operation, document, document_hash, created_at
       FROM project_revisions WHERE project_id = $1 AND revision = $2`,
      [projectId, revision],
    );
    const row = result.rows[0];
    if (row === undefined)
      throw new ControlPlaneError('REVISION_NOT_FOUND', `revision ${revision} was not found`);
    return projectRevisionOf(row);
  }

  async restoreProjectRevision(
    actor: Actor,
    projectId: string,
    input: RestoreProjectRevisionInput,
  ): Promise<ProjectRevisionV1> {
    await this.project(actor, projectId);
    validateRevisionNumber(input.revision);
    validateBaseRevision(input.baseRevision);
    validateIdempotencyKey(input.idempotencyKey);
    const source = await this.getProjectRevision(actor, projectId, input.revision);
    const result = await this.appendProjectRevision(actor, projectId, {
      baseRevision: input.baseRevision,
      idempotencyKey: input.idempotencyKey,
      document: source.document,
      operation: 'restore',
      targetRevision: input.revision,
      label: input.label ?? `restore revision ${String(input.revision)}`,
    });
    return result;
  }

  async createRecoveredCopy(
    actor: Actor,
    sourceProjectId: string,
    input: CreateRecoveredCopyInput,
  ): Promise<RecoveredCopy> {
    await this.project(actor, sourceProjectId);
    validateRecoveredCopyInput(input);
    return this.transaction(async (client) => {
      await this.project(actor, sourceProjectId, client);
      await client.query('SELECT id FROM projects WHERE id = $1 FOR UPDATE', [sourceProjectId]);
      const priorResult = await client.query<ProjectRecoveryCopyRow>(
        `SELECT source_project_id, idempotency_key, request_fingerprint, recovered_project_id, response, created_at
         FROM project_recovery_copies WHERE source_project_id = $1 AND idempotency_key = $2`,
        [sourceProjectId, input.idempotencyKey],
      );
      const prior = priorResult.rows[0];
      const fingerprint = recoveryRequestFingerprint(input);
      if (prior !== undefined) {
        if (prior.request_fingerprint !== fingerprint)
          throw new ControlPlaneError(
            'IDEMPOTENCY_CONFLICT',
            'idempotency key was already used for another recovered copy',
          );
        return parseRecoveredCopy(prior.response);
      }
      const currentResult = await client.query<{ readonly revision: number }>(
        'SELECT revision FROM project_documents WHERE project_id = $1 FOR UPDATE',
        [sourceProjectId],
      );
      const sourceHeadRevision = currentResult.rows[0]?.revision ?? 0;
      if (sourceHeadRevision <= input.baseRevision)
        throw revisionConflict(input.baseRevision, sourceHeadRevision);

      let requestedDocument: ProjectDocumentV2;
      if (input.operation.kind === 'append') {
        // The incoming project identity is deliberately rewritten below. Validate its
        // schema and transport safety before doing so, but do not require the old ID
        // to equal the source route.
        const diagnostics = validateProjectDocumentV2Safe(input.operation.document);
        if (diagnostics !== undefined) throw diagnostics;
        requestedDocument = cloneProjectDocument(input.operation.document);
      } else {
        const target = await client.query<ProjectRevisionRow>(
          `SELECT project_id, revision, base_revision, idempotency_key, operation, document, document_hash, created_at
           FROM project_revisions WHERE project_id = $1 AND revision = $2`,
          [sourceProjectId, input.operation.targetRevision],
        );
        const row = target.rows[0];
        if (row === undefined)
          throw new ControlPlaneError(
            'REVISION_NOT_FOUND',
            `revision ${String(input.operation.targetRevision)} was not found`,
          );
        requestedDocument = parseProjectDocument(row.document);
      }
      const recoveredProjectId = `recovered-${randomUUID()}`;
      const document = rewriteRecoveredDocument(
        requestedDocument,
        recoveredProjectId,
        input.suggestedName,
      );
      const createdAt = new Date();
      const provenance: RecoveredCopyProvenance = {
        sourceProjectId,
        baseRevision: input.baseRevision,
        sourceHeadRevision,
        operation: cloneJson(input.operation),
        requestedDocumentHash: documentHash(requestedDocument),
      };
      const response: RecoveredCopy = {
        kind: 'recovered-copy',
        projectId: recoveredProjectId,
        name: input.suggestedName,
        document,
        basedOnRevision: input.baseRevision,
        serverRevision: 1,
        createdAt: createdAt.toISOString(),
        provenance,
      };
      await client.query(
        'INSERT INTO projects (id, owner_id, title, revision) VALUES ($1, $2, $3, 0)',
        [recoveredProjectId, actor.id, input.suggestedName],
      );
      const revisionOperation = {
        kind: 'replace' as const,
        idempotencyKey: input.idempotencyKey,
        label: 'recovered copy',
      };
      await client.query(
        `INSERT INTO project_revisions
           (project_id, revision, base_revision, idempotency_key, operation, document, document_hash, created_at)
         VALUES ($1, 1, 0, $2, $3::jsonb, $4::jsonb, $5, $6)`,
        [
          recoveredProjectId,
          input.idempotencyKey,
          JSON.stringify(revisionOperation),
          JSON.stringify(document),
          documentHash(document),
          createdAt,
        ],
      );
      await client.query(
        `INSERT INTO project_documents (project_id, revision, document, document_hash, updated_at)
         VALUES ($1, 1, $2::jsonb, $3, $4)`,
        [recoveredProjectId, JSON.stringify(document), documentHash(document), createdAt],
      );
      await client.query(
        `INSERT INTO project_recovery_copies
           (source_project_id, idempotency_key, request_fingerprint, recovered_project_id, response, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
        [
          sourceProjectId,
          input.idempotencyKey,
          fingerprint,
          recoveredProjectId,
          JSON.stringify(response),
          createdAt,
        ],
      );
      return response;
    });
  }

  async createProject(actor: Actor, id: string, title: string): Promise<ProjectMetadata> {
    assertActor(actor);
    try {
      const result = await this.pool.query<ProjectRow>(
        'INSERT INTO projects (id, owner_id, title, revision) VALUES ($1, $2, $3, 0) RETURNING *',
        [id, actor.id, title],
      );
      return projectOf(requiredRow(result.rows[0], 'PROJECT_CREATE_FAILED'));
    } catch (error) {
      if (isPostgresError(error) && error.code === '23505') {
        const existing = await this.pool.query<{ readonly owner_id: string }>(
          'SELECT owner_id FROM projects WHERE id = $1',
          [id],
        );
        if (existing.rows[0]?.owner_id === actor.id)
          throw new ControlPlaneError('PROJECT_EXISTS', id);
        // Do not reveal that an opaque project ID belongs to another owner.
        throw new ControlPlaneError('PROJECT_NOT_FOUND', id);
      }
      throw databaseError(error, 'PROJECT_EXISTS', id);
    }
  }

  async updateProject(
    actor: Actor,
    id: string,
    title: string,
    baseRevision: number,
  ): Promise<ProjectMetadata> {
    assertActor(actor);
    const result = await this.pool.query<ProjectRow>(
      `UPDATE projects SET title = $3, revision = revision + 1
       WHERE id = $1 AND owner_id = $2 AND revision = $4 RETURNING *`,
      [id, actor.id, title, baseRevision],
    );
    if (result.rows[0] !== undefined) return projectOf(result.rows[0]);
    const current = await this.project(actor, id);
    throw new ControlPlaneError(
      'REVISION_CONFLICT',
      `expected ${baseRevision}, found ${current.revision}`,
    );
  }

  async setAssetSync(actor: Actor, projectId: string, enabled: boolean): Promise<ProjectMetadata> {
    assertActor(actor);
    if (typeof enabled !== 'boolean')
      throw new ControlPlaneError('ASSET_SYNC_INVALID', 'asset sync enabled must be boolean');
    const result = await this.pool.query<ProjectRow>(
      `UPDATE projects SET asset_sync_enabled = $3
       WHERE id = $1 AND owner_id = $2 RETURNING *`,
      [projectId, actor.id, enabled],
    );
    if (result.rows[0] === undefined) throw new ControlPlaneError('PROJECT_NOT_FOUND', projectId);
    return projectOf(result.rows[0]);
  }

  async registerAsset(
    actor: Actor,
    projectId: string,
    asset: AssetRegistration,
    now = Date.now(),
  ): Promise<MediaAssetRecord> {
    validateAssetRegistration(asset);
    const sortName = asset.displayName.trim().toLocaleLowerCase();
    return this.transaction(async (client) => {
      await this.project(actor, projectId, client);
      try {
        const result = await client.query<MediaAssetRow>(
          `INSERT INTO media_assets
             (id, project_id, kind, display_name, sha256, byte_length, descriptor, locations, tags, sort_name, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11) RETURNING *`,
          [
            asset.id,
            projectId,
            asset.kind,
            asset.displayName,
            asset.sha256,
            asset.bytes,
            JSON.stringify(asset.descriptor),
            JSON.stringify(asset.locations),
            JSON.stringify([]),
            sortName,
            new Date(now),
          ],
        );
        const created = requiredRow(result.rows[0], 'ASSET_CREATE_FAILED');
        await recordObjectReferences(client, projectId, asset.id, undefined, asset.locations, now);
        return mediaAssetOf(created);
      } catch (error) {
        throw databaseError(error, 'ASSET_EXISTS', asset.id);
      }
    });
  }

  async attachCloudOriginal(
    actor: Actor,
    projectId: string,
    assetId: string,
    location: AssetLocationRecord & { readonly kind: 'private-object' },
  ): Promise<MediaAssetRecord> {
    if (location.kind !== 'private-object')
      throw new ControlPlaneError('ASSET_INVALID', 'cloud original requires private-object');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(location.ref))
      throw new ControlPlaneError('ASSET_INVALID', 'asset location is invalid');
    return this.transaction(async (client) => {
      assertActor(actor);
      const projectResult = await client.query<ProjectRow>(
        'SELECT * FROM projects WHERE id = $1 AND owner_id = $2 FOR UPDATE',
        [projectId, actor.id],
      );
      if (projectResult.rows[0] === undefined)
        throw new ControlPlaneError('PROJECT_NOT_FOUND', projectId);
      const project = projectOf(projectResult.rows[0]);
      if (!project.assetSyncEnabled)
        throw new ControlPlaneError(
          'ASSET_SYNC_DISABLED',
          'private backup requires explicit project consent',
        );
      const existing = await client.query<MediaAssetRow>(
        'SELECT * FROM media_assets WHERE id = $1 AND project_id = $2 FOR SHARE',
        [assetId, projectId],
      );
      if (existing.rows[0] === undefined) throw new ControlPlaneError('ASSET_NOT_FOUND', assetId);
      const asset = mediaAssetOf(existing.rows[0]);
      if (asset.kind !== 'image')
        throw new ControlPlaneError('ASSET_INVALID', 'cloud original backup is image-only in v1');
      const kept = asset.locations.filter((entry) => entry.kind !== 'private-object');
      const locations = [...kept, { kind: 'private-object' as const, ref: location.ref }];
      if (locations.length === 0 || locations.length > 2)
        throw new ControlPlaneError('ASSET_INVALID', 'one or two opaque locations are required');
      const result = await client.query<MediaAssetRow>(
        `UPDATE media_assets SET locations = $3::jsonb
         WHERE id = $1 AND project_id = $2 RETURNING *`,
        [assetId, projectId, JSON.stringify(locations)],
      );
      await recordObjectReferences(client, projectId, assetId, undefined, locations, Date.now());
      return mediaAssetOf(requiredRow(result.rows[0], 'ASSET_UPDATE_FAILED'));
    });
  }

  async updateAssetMetadata(
    actor: Actor,
    projectId: string,
    assetId: string,
    patch: {
      readonly tags?: readonly string[];
      readonly sortName?: string;
      readonly displayName?: string;
    },
  ): Promise<MediaAssetRecord> {
    return this.transaction(async (client) => {
      await this.project(actor, projectId, client);
      const existing = await client.query<MediaAssetRow>(
        'SELECT * FROM media_assets WHERE id = $1 AND project_id = $2',
        [assetId, projectId],
      );
      if (existing.rows[0] === undefined) throw new ControlPlaneError('ASSET_NOT_FOUND', assetId);
      const current = mediaAssetOf(existing.rows[0]);
      const tags = patch.tags === undefined ? current.tags : validateAssetTags(patch.tags);
      const sortName =
        patch.sortName === undefined ? current.sortName : validateSortName(patch.sortName);
      const displayName = patch.displayName ?? current.displayName;
      if (
        typeof displayName !== 'string' ||
        displayName.length === 0 ||
        displayName.length > 255 ||
        /[\\/]/.test(displayName)
      ) {
        throw new ControlPlaneError('ASSET_INVALID', 'display name must not contain a path');
      }
      const result = await client.query<MediaAssetRow>(
        `UPDATE media_assets
           SET tags = $3::jsonb, sort_name = $4, display_name = $5
         WHERE id = $1 AND project_id = $2 RETURNING *`,
        [assetId, projectId, JSON.stringify(tags), sortName, displayName],
      );
      return mediaAssetOf(requiredRow(result.rows[0], 'ASSET_UPDATE_FAILED'));
    });
  }

  async deleteAsset(
    actor: Actor,
    projectId: string,
    assetId: string,
  ): Promise<{ readonly id: string }> {
    const plan = await this.transaction(async (client) => {
      await this.project(actor, projectId, client);
      const existing = await client.query<MediaAssetRow>(
        'SELECT * FROM media_assets WHERE id = $1 AND project_id = $2 FOR UPDATE',
        [assetId, projectId],
      );
      if (existing.rows[0] === undefined) {
        const prior = await client.query<{ readonly asset_id: string }>(
          'SELECT asset_id FROM asset_revocation_audits WHERE project_id = $1 AND asset_id = $2 ORDER BY revoke_id DESC LIMIT 1',
          [projectId, assetId],
        );
        if (prior.rows[0] !== undefined)
          return { id: assetId, revokeId: undefined, refs: [] as readonly string[] };
        throw new ControlPlaneError('ASSET_NOT_FOUND', assetId);
      }
      const asset = mediaAssetOf(existing.rows[0]);
      const derivatives = await client.query<MediaDerivativeRow>(
        'SELECT * FROM media_derivatives WHERE project_id = $1 AND asset_id = $2 ORDER BY id',
        [projectId, assetId],
      );
      const derivativeRecords = derivatives.rows.map(mediaDerivativeOf);
      const historical = await client.query<{ readonly object_ref: string }>(
        'SELECT object_ref FROM asset_object_references WHERE project_id = $1 AND asset_id = $2 AND revoked_at IS NULL ORDER BY id',
        [projectId, assetId],
      );
      const pendingCleanup = await client.query<{ readonly object_ref: string }>(
        `SELECT object_ref FROM private_object_cleanup_refs
         WHERE project_id = $1 AND asset_id = $2 AND revocation_id IS NULL
           AND state = 'registered' ORDER BY id`,
        [projectId, assetId],
      );
      const refs = uniqueOpaqueRefs([
        ...historical.rows.map((row) => row.object_ref),
        ...pendingCleanup.rows.map((row) => row.object_ref),
        ...privateObjectRefs(asset.locations),
        ...derivativeRecords.flatMap((derivative) => privateObjectRefs(derivative.locations)),
      ]);
      const canceled = await client.query<{ readonly id: string; readonly state: Job['state'] }>(
        `UPDATE jobs SET state = CASE WHEN state = 'queued' THEN 'canceled' ELSE state END,
             cancel_requested = CASE WHEN state = 'leased' THEN true ELSE cancel_requested END,
             asset_revoked = true
         WHERE project_id = $1 AND asset_id = $2 AND state IN ('queued', 'leased')
         RETURNING id, state`,
        [projectId, assetId],
      );
      for (const job of canceled.rows) {
        await this.event(
          client,
          job.id,
          job.state === 'leased' ? 'cancel-requested' : 'canceled',
          Date.now(),
        );
      }
      const canceledJobIds = canceled.rows.map((job) => job.id).sort();
      const audit = await client.query<{ readonly revoke_id: string | number }>(
        `INSERT INTO asset_revocation_audits
           (project_id, asset_id, actor_id, asset_snapshot, derivative_snapshot, object_refs,
            canceled_job_ids, purge_state, purge_error, requested_at, purged_at, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, 'pending', NULL, $8, NULL, $8)
         RETURNING revoke_id`,
        [
          projectId,
          assetId,
          actor.id,
          JSON.stringify(asset),
          JSON.stringify(derivativeRecords),
          JSON.stringify(refs),
          JSON.stringify(canceledJobIds),
          new Date(),
        ],
      );
      const revokeId = audit.rows[0]?.revoke_id;
      if (revokeId === undefined)
        throw new ControlPlaneError('DATABASE_ERROR', 'revocation audit was not recorded');
      for (const ref of privateObjectRefs(asset.locations)) {
        await client.query(
          `INSERT INTO asset_object_references
             (project_id, asset_id, derivative_id, object_kind, object_ref, revocation_id, revoked_at, created_at)
           VALUES ($1, $2, NULL, 'original', $3, NULL, NULL, $4)`,
          [projectId, assetId, ref, new Date()],
        );
      }
      for (const derivative of derivativeRecords) {
        for (const ref of privateObjectRefs(derivative.locations)) {
          await client.query(
            `INSERT INTO asset_object_references
               (project_id, asset_id, derivative_id, object_kind, object_ref, revocation_id, revoked_at, created_at)
             VALUES ($1, $2, $3, 'derivative', $4, NULL, NULL, $5)`,
            [projectId, assetId, derivative.id, ref, new Date()],
          );
        }
      }
      await client.query(
        `UPDATE asset_object_references
         SET revocation_id = $3, revoked_at = $4
         WHERE project_id = $1 AND asset_id = $2 AND revoked_at IS NULL`,
        [projectId, assetId, revokeId, new Date()],
      );
      await client.query(
        `UPDATE private_object_cleanup_refs SET revocation_id = $3, updated_at = NOW()
         WHERE project_id = $1 AND asset_id = $2 AND revocation_id IS NULL`,
        [projectId, assetId, revokeId],
      );
      await client.query('DELETE FROM media_derivatives WHERE project_id = $1 AND asset_id = $2', [
        projectId,
        assetId,
      ]);
      await client.query('DELETE FROM media_assets WHERE id = $1 AND project_id = $2', [
        assetId,
        projectId,
      ]);
      return { id: assetId, revokeId: Number(revokeId), refs };
    });
    if (this.#privateObjectStore !== undefined)
      await this.purgeAssetReferences(projectId, assetId, plan.revokeId, plan.refs);
    return { id: plan.id };
  }

  /** Durable audit seam for operators/tests; ownership is still enforced. */
  async assetRevocationAudit(
    actor: Actor,
    projectId: string,
    assetId: string,
  ): Promise<AssetRevocationAudit> {
    await this.project(actor, projectId);
    const result = await this.pool.query<AssetRevocationAuditRow>(
      'SELECT * FROM asset_revocation_audits WHERE project_id = $1 AND asset_id = $2 ORDER BY revoke_id DESC LIMIT 1',
      [projectId, assetId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new ControlPlaneError('ASSET_NOT_FOUND', assetId);
    return assetRevocationAuditOf(row);
  }

  async retryAssetPurge(
    actor: Actor,
    projectId: string,
    assetId: string,
  ): Promise<{ readonly id: string }> {
    await this.project(actor, projectId);
    const result = await this.pool.query<{
      readonly revoke_id: string | number;
      readonly object_refs: unknown;
    }>(
      'SELECT revoke_id, object_refs FROM asset_revocation_audits WHERE project_id = $1 AND asset_id = $2 ORDER BY revoke_id DESC LIMIT 1',
      [projectId, assetId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new ControlPlaneError('ASSET_NOT_FOUND', assetId);
    const refs = uniqueOpaqueRefs(
      jsonArray(row.object_refs).filter((value): value is string => typeof value === 'string'),
    );
    if (this.#privateObjectStore !== undefined)
      await this.purgeAssetReferences(projectId, assetId, Number(row.revoke_id), refs);
    return { id: assetId };
  }

  async assetsForProject(actor: Actor, projectId: string): Promise<readonly MediaAssetRecord[]> {
    await this.project(actor, projectId);
    const result = await this.pool.query<MediaAssetRow>(
      "SELECT * FROM media_assets WHERE project_id = $1 ORDER BY COALESCE(CASE WHEN sort_name = '' THEN NULL ELSE sort_name END, lower(display_name)), id",
      [projectId],
    );
    return result.rows.map(mediaAssetOf);
  }

  async assetsForOwner(actor: Actor): Promise<readonly MediaAssetRecord[]> {
    assertActor(actor);
    const result = await this.pool.query<MediaAssetRow>(
      `SELECT a.*
       FROM media_assets a
       JOIN projects p ON p.id = a.project_id
       WHERE p.owner_id = $1
       ORDER BY COALESCE(CASE WHEN a.sort_name = '' THEN NULL ELSE a.sort_name END, lower(a.display_name)), a.id`,
      [actor.id],
    );
    return result.rows.map(mediaAssetOf);
  }

  async sharedCloudAssets(actor: Actor): Promise<readonly MediaAssetRecord[]> {
    assertActor(actor);
    const result = await this.pool.query<MediaAssetRow>(
      `SELECT a.* FROM media_assets a
       JOIN projects p ON p.id = a.project_id
       WHERE (p.owner_id = $1 OR (p.id = $2 AND p.owner_id = $3))
       ORDER BY COALESCE(CASE WHEN a.sort_name = '' THEN NULL ELSE a.sort_name END, lower(a.display_name)), a.id`,
      [actor.id, EXPLICIT_SHARED_LIBRARY_PROJECT_ID, EXPLICIT_SHARED_LIBRARY_OWNER_ID],
    );
    return result.rows
      .map(mediaAssetOf)
      .filter((asset) => asset.locations.some((location) => location.kind === 'private-object'));
  }

  async sharedCloudAsset(actor: Actor, assetId: string): Promise<MediaAssetRecord> {
    assertActor(actor);
    const result = await this.pool.query<MediaAssetRow>(
      `SELECT a.* FROM media_assets a
       JOIN projects p ON p.id = a.project_id
       WHERE a.id = $1
         AND (p.owner_id = $2 OR (p.id = $3 AND p.owner_id = $4))`,
      [assetId, actor.id, EXPLICIT_SHARED_LIBRARY_PROJECT_ID, EXPLICIT_SHARED_LIBRARY_OWNER_ID],
    );
    if (result.rows[0] === undefined) throw new ControlPlaneError('ASSET_NOT_FOUND', assetId);
    const asset = mediaAssetOf(result.rows[0]);
    if (!asset.locations.some((location) => location.kind === 'private-object'))
      throw new ControlPlaneError('ASSET_NOT_FOUND', assetId);
    return asset;
  }

  async registerLocalDerivative(
    actor: Actor,
    projectId: string,
    derivative: LocalDerivativeRegistration,
    now = Date.now(),
  ): Promise<MediaDerivativeRecord> {
    return this.registerDerivative(actor, projectId, derivative, now, false);
  }

  private async registerDerivative(
    actor: Actor,
    projectId: string,
    derivative: LocalDerivativeRegistration | CloudDerivativeRegistration,
    now: number,
    cloud: boolean,
  ): Promise<MediaDerivativeRecord> {
    if (cloud) validateCloudDerivativeRegistration(derivative as CloudDerivativeRegistration);
    else validateLocalDerivativeRegistration(derivative as LocalDerivativeRegistration);
    return this.transaction(async (client) => {
      await this.asset(actor, projectId, derivative.assetId, client);
      await lockAssetForJob(client, projectId, derivative.assetId);
      try {
        const result = await client.query<MediaDerivativeRow>(
          `INSERT INTO media_derivatives
             (id, project_id, asset_id, kind, profile, sha256, byte_length, descriptor, availability, locations, verified_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb, $11) RETURNING *`,
          [
            derivative.id,
            projectId,
            derivative.assetId,
            derivative.kind,
            derivative.profile,
            derivative.sha256,
            derivative.bytes,
            JSON.stringify(derivative.descriptor),
            derivative.availability,
            JSON.stringify(derivative.locations),
            new Date(now),
          ],
        );
        const created = requiredRow(result.rows[0], 'DERIVATIVE_CREATE_FAILED');
        await recordObjectReferences(
          client,
          projectId,
          derivative.assetId,
          derivative.id,
          derivative.locations,
          now,
        );
        return mediaDerivativeOf(created);
      } catch (error) {
        throw databaseError(error, 'DERIVATIVE_EXISTS', derivative.id);
      }
    });
  }

  async registerWorkerCloudDerivative(
    workerId: string,
    jobId: string,
    derivative: CloudDerivativeRegistration,
    now = Date.now(),
  ): Promise<MediaDerivativeRecord> {
    validateCloudDerivativeRegistration(derivative);
    const result = await this.pool.query<{
      readonly project_id: string;
      readonly asset_id: string | null;
      readonly owner_id: string;
      readonly asset_sync_enabled: boolean;
    }>(
      `SELECT jobs.project_id, jobs.asset_id, workers.owner_id, projects.asset_sync_enabled
       FROM jobs JOIN workers ON workers.id = jobs.lease_owner
       JOIN projects ON projects.id = jobs.project_id
       WHERE jobs.id = $1 AND jobs.state = 'leased' AND jobs.lease_owner = $2
         AND jobs.lease_expires_at > $3 AND workers.revoked_at IS NULL`,
      [jobId, workerId, new Date(now)],
    );
    const job = result.rows[0];
    if (job === undefined || job.asset_id !== derivative.assetId || !job.asset_sync_enabled)
      throw new ControlPlaneError('DERIVATIVE_UPLOAD_DENIED', jobId);
    return this.registerDerivative({ id: job.owner_id }, job.project_id, derivative, now, true);
  }

  async derivativesForAsset(
    actor: Actor,
    projectId: string,
    assetId: string,
  ): Promise<readonly MediaDerivativeRecord[]> {
    await this.asset(actor, projectId, assetId);
    const result = await this.pool.query<MediaDerivativeRow>(
      'SELECT * FROM media_derivatives WHERE project_id = $1 AND asset_id = $2 ORDER BY id',
      [projectId, assetId],
    );
    return result.rows.map(mediaDerivativeOf);
  }

  async cloudDerivativeForOwner(
    actor: Actor,
    projectId: string,
    assetId: string,
    derivativeId: string,
  ): Promise<MediaDerivativeRecord> {
    const project = await this.project(actor, projectId);
    if (!project.assetSyncEnabled) throw new ControlPlaneError('ASSET_SYNC_DISABLED', projectId);
    await this.asset(actor, projectId, assetId);
    const result = await this.pool.query<MediaDerivativeRow>(
      'SELECT * FROM media_derivatives WHERE id = $1 AND project_id = $2 AND asset_id = $3',
      [derivativeId, projectId, assetId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new ControlPlaneError('DERIVATIVE_NOT_FOUND', derivativeId);
    const derivative = mediaDerivativeOf(row);
    if (
      derivative.availability !== 'available-cloud' ||
      !derivative.locations.some((location) => location.kind === 'private-object')
    )
      throw new ControlPlaneError('DERIVATIVE_UNAVAILABLE', derivativeId);
    return derivative;
  }

  async registerWorkerRenderArtifact(
    workerId: string,
    jobId: string,
    artifact: WorkerRenderArtifactRegistration,
    now = Date.now(),
  ): Promise<RenderArtifactRecord> {
    validateWorkerRenderArtifactRegistration(artifact);
    return this.transaction(async (client) => {
      const lease = await client.query<{
        readonly project_id: string;
        readonly type: string;
        readonly owner_id: string;
        readonly revoked_at: Date | null;
      }>(
        `SELECT jobs.project_id, jobs.type, workers.owner_id, workers.revoked_at
         FROM jobs JOIN workers ON workers.id = jobs.lease_owner
         JOIN projects ON projects.id = jobs.project_id AND projects.owner_id = workers.owner_id
         WHERE jobs.id = $1 AND jobs.state = 'leased' AND jobs.lease_owner = $2
           AND jobs.lease_expires_at > $3`,
        [jobId, workerId, new Date(now)],
      );
      const row = lease.rows[0];
      if (row === undefined || row.type !== 'render.export' || row.revoked_at !== null)
        throw new ControlPlaneError('ARTIFACT_UPLOAD_DENIED', jobId);
      const existing = await client.query<RenderArtifactRow>(
        'SELECT * FROM render_artifacts WHERE id = $1',
        [artifact.id],
      );
      const prior = existing.rows[0];
      if (prior !== undefined) {
        const priorLocation = jsonObject(prior.location);
        if (
          prior.project_id === row.project_id &&
          prior.job_id === jobId &&
          prior.output_ref === artifact.outputRef &&
          prior.sha256 === artifact.sha256 &&
          safeByteLength(prior.byte_length) === artifact.bytes &&
          priorLocation.kind === 'private-object' &&
          priorLocation.ref === artifact.location.ref
        )
          return renderArtifactOf(prior);
        throw new ControlPlaneError('ARTIFACT_EXISTS', artifact.id);
      }
      try {
        const inserted = await client.query<RenderArtifactRow>(
          `INSERT INTO render_artifacts
             (id, project_id, job_id, output_ref, sha256, byte_length, descriptor, location, verified_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)
           RETURNING *`,
          [
            artifact.id,
            row.project_id,
            jobId,
            artifact.outputRef,
            artifact.sha256,
            artifact.bytes,
            JSON.stringify(artifact.descriptor),
            JSON.stringify(artifact.location),
            new Date(now),
          ],
        );
        return renderArtifactOf(requiredRow(inserted.rows[0], 'ARTIFACT_CREATE_FAILED'));
      } catch (error) {
        throw databaseError(error, 'ARTIFACT_EXISTS', artifact.id);
      }
    });
  }

  async renderArtifactForOwner(
    actor: Actor,
    projectId: string,
    artifactId: string,
  ): Promise<RenderArtifactRecord> {
    await this.project(actor, projectId);
    const result = await this.pool.query<RenderArtifactRow>(
      `SELECT artifacts.* FROM render_artifacts AS artifacts
       JOIN jobs ON jobs.id = artifacts.job_id
       WHERE artifacts.id = $1 AND artifacts.project_id = $2
         AND jobs.state = 'completed' AND jobs.type = 'render.export'
         AND jobs.result_sha256 = artifacts.sha256
         AND jobs.result_bytes = artifacts.byte_length
         AND jobs.result_receipt->>'outputRef' = artifacts.output_ref`,
      [artifactId, projectId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new ControlPlaneError('ARTIFACT_NOT_FOUND', artifactId);
    return renderArtifactOf(row);
  }

  async renderArtifactForWorker(
    workerId: string,
    jobId: string,
    outputRef: string,
  ): Promise<RenderArtifactRecord> {
    const worker = await this.pool.query<{ readonly owner_id: string }>(
      'SELECT owner_id FROM workers WHERE id = $1 AND revoked_at IS NULL',
      [workerId],
    );
    const ownerId = worker.rows[0]?.owner_id;
    if (ownerId === undefined) throw new ControlPlaneError('ARTIFACT_NOT_FOUND', outputRef);
    const inspect = await this.pool.query<{ readonly project_id: string }>(
      `SELECT project_id FROM jobs
       WHERE id = $1 AND type = 'render.inspect'
         AND state = 'leased' AND lease_owner = $2
         AND lease_expires_at > NOW()`,
      [jobId, workerId],
    );
    const projectId = inspect.rows[0]?.project_id;
    if (projectId === undefined) throw new ControlPlaneError('ARTIFACT_NOT_FOUND', outputRef);
    const project = await this.pool.query<{ readonly owner_id: string }>(
      'SELECT owner_id FROM projects WHERE id = $1',
      [projectId],
    );
    if (project.rows[0]?.owner_id !== ownerId)
      throw new ControlPlaneError('ARTIFACT_NOT_FOUND', outputRef);
    const result = await this.pool.query<RenderArtifactRow>(
      `SELECT * FROM render_artifacts
       WHERE project_id = $1 AND output_ref = $2`,
      [projectId, outputRef],
    );
    const row = result.rows[0];
    if (row === undefined) throw new ControlPlaneError('ARTIFACT_NOT_FOUND', outputRef);
    const exported = await this.pool.query<{
      readonly state: string;
      readonly type: string;
      readonly result_sha256: string | null;
      readonly result_bytes: string | number | null;
      readonly result_receipt: unknown;
    }>('SELECT state, type, result_sha256, result_bytes, result_receipt FROM jobs WHERE id = $1', [
      row.job_id,
    ]);
    const exportRow = exported.rows[0];
    if (
      exportRow?.state !== 'completed' ||
      exportRow.type !== 'render.export' ||
      exportRow.result_sha256 !== row.sha256 ||
      safeByteLength(exportRow.result_bytes ?? 0) !== row.byte_length ||
      jsonObject(exportRow.result_receipt).outputRef !== row.output_ref
    )
      throw new ControlPlaneError('ARTIFACT_NOT_FOUND', outputRef);
    return renderArtifactOf(row);
  }

  async pairWorker(actor: Actor, workerId: string): Promise<WorkerRecord> {
    assertActor(actor);
    const result = await this.pool.query<WorkerRow>(
      `INSERT INTO workers (id, owner_id, revoked_at) VALUES ($1, $2, NULL)
       ON CONFLICT (id) DO UPDATE SET revoked_at = NULL
       WHERE workers.owner_id = EXCLUDED.owner_id
       RETURNING *`,
      [workerId, actor.id],
    );
    if (result.rows[0] === undefined) throw new ControlPlaneError('WORKER_NOT_FOUND', workerId);
    return workerOf(result.rows[0]);
  }

  async createPairingOffer(
    workerId: string,
    pairingCodeHash: string,
    expiresAt: number,
  ): Promise<WorkerPairingOffer> {
    if (workerId.length === 0 || pairingCodeHash.length === 0 || expiresAt <= 0)
      throw new ControlPlaneError('PAIRING_OFFER_INVALID', 'worker pairing offer is invalid');
    await this.pool.query(
      `INSERT INTO worker_pairing_offers (worker_id, pairing_code_hash, owner_id, expires_at)
       VALUES ($1, $2, NULL, $3)
       ON CONFLICT (worker_id) DO UPDATE
       SET pairing_code_hash = EXCLUDED.pairing_code_hash, owner_id = NULL, expires_at = EXCLUDED.expires_at`,
      [workerId, pairingCodeHash, new Date(expiresAt)],
    );
    return { workerId, expiresAt };
  }

  async approvePairing(
    actor: Actor,
    workerId: string,
    pairingCodeHash: string,
    now = Date.now(),
  ): Promise<WorkerRecord> {
    assertActor(actor);
    const result = await this.pool.query<PairingOfferRow>(
      `UPDATE worker_pairing_offers SET owner_id = $2
       WHERE worker_id = $1 AND pairing_code_hash = $3 AND expires_at > $4
       RETURNING *`,
      [workerId, actor.id, pairingCodeHash, new Date(now)],
    );
    if (result.rows[0] === undefined) throw new ControlPlaneError('PAIRING_CODE_INVALID', workerId);
    return {
      id: workerId,
      ownerId: actor.id,
      paired: false,
      revoked: false,
      capabilities: [],
      localAssetIds: [],
    };
  }

  async claimWorkerSession(
    workerId: string,
    pairingCodeHash: string,
    sessionTokenHash: string,
    expiresAt: number,
    now = Date.now(),
  ): Promise<WorkerSession | undefined> {
    return this.transaction(async (client) => {
      const offer = await client.query<PairingOfferRow>(
        `DELETE FROM worker_pairing_offers
         WHERE worker_id = $1 AND pairing_code_hash = $2 AND owner_id IS NOT NULL AND expires_at > $3
         RETURNING *`,
        [workerId, pairingCodeHash, new Date(now)],
      );
      const row = offer.rows[0];
      if (row === undefined || row.owner_id === null) return undefined;
      await client.query(
        `INSERT INTO workers (id, owner_id, revoked_at, session_token_hash, session_expires_at)
         VALUES ($1, $2, NULL, $3, $4)
         ON CONFLICT (id) DO UPDATE SET owner_id = EXCLUDED.owner_id, revoked_at = NULL,
             session_token_hash = EXCLUDED.session_token_hash, session_expires_at = EXCLUDED.session_expires_at`,
        [workerId, row.owner_id, sessionTokenHash, new Date(expiresAt)],
      );
      return { workerId, expiresAt };
    });
  }

  async authenticateWorker(
    sessionTokenHash: string,
    now = Date.now(),
  ): Promise<string | undefined> {
    const result = await this.pool.query<WorkerRow>(
      `SELECT * FROM workers
       WHERE session_token_hash = $1 AND session_expires_at > $2 AND revoked_at IS NULL`,
      [sessionTokenHash, new Date(now)],
    );
    return result.rows[0]?.id;
  }

  async helloWorker(
    workerId: string,
    capabilities: readonly string[],
    localAssetIds: readonly string[] = [],
    now = Date.now(),
  ): Promise<WorkerRecord> {
    const assets = normalizeOpaqueAssetIds(localAssetIds);
    const result = await this.pool.query<WorkerRow>(
      `UPDATE workers SET capabilities = $2::jsonb, local_asset_ids = $3::jsonb, last_seen_at = $4
       WHERE id = $1 AND revoked_at IS NULL RETURNING *`,
      [
        workerId,
        JSON.stringify([...new Set(capabilities)].sort()),
        JSON.stringify(assets),
        new Date(now),
      ],
    );
    if (result.rows[0] === undefined) throw new ControlPlaneError('WORKER_UNAUTHORIZED', workerId);
    return workerOf(result.rows[0]);
  }

  async revokeWorker(actor: Actor, workerId: string): Promise<WorkerRecord> {
    assertActor(actor);
    const result = await this.pool.query<WorkerRow>(
      'UPDATE workers SET revoked_at = NOW() WHERE id = $1 AND owner_id = $2 RETURNING *',
      [workerId, actor.id],
    );
    if (result.rows[0] === undefined) throw new ControlPlaneError('WORKER_NOT_FOUND', workerId);
    return workerOf(result.rows[0]);
  }

  async enqueue(
    actor: Actor,
    id: string,
    projectId: string,
    type: string,
    now = Date.now(),
    assetId?: string,
    workerJob?: WorkerJobV1,
  ): Promise<Job> {
    if (!isWorkerJobType(type))
      throw new ControlPlaneError('WORKER_JOB_INVALID', 'unsupported Worker job type');
    if (type === 'asset.thumbnail')
      throw new ControlPlaneError(
        'ASSET_JOB_INVALID',
        'asset thumbnail requires an opaque asset ID',
      );
    return this.transaction(async (client) => {
      await this.project(actor, projectId, client);
      const existing = await client.query<JobRow>('SELECT * FROM jobs WHERE id = $1', [id]);
      if (existing.rows[0] !== undefined) return jobOf(existing.rows[0]);
      const typedJob = workerJobFor(id, projectId, type, assetId, workerJob);
      if (type === 'render.inspect' && typedJob !== undefined) {
        const payload = typedJob.payload as RenderInspectPayload;
        if (payload.artifactId !== undefined || payload.outputRef !== undefined) {
          const artifact = await client.query<{ readonly id: string }>(
            `SELECT artifacts.id FROM render_artifacts AS artifacts
             JOIN jobs AS exported ON exported.id = artifacts.job_id
             WHERE artifacts.id = $1 AND artifacts.project_id = $2
               AND artifacts.output_ref = $3
               AND exported.state = 'completed' AND exported.type = 'render.export'
               AND exported.result_sha256 = artifacts.sha256
               AND exported.result_bytes = artifacts.byte_length
               AND exported.result_receipt->>'outputRef' = artifacts.output_ref`,
            [payload.artifactId, projectId, payload.outputRef],
          );
          if (artifact.rows[0] === undefined)
            throw new ControlPlaneError(
              'ARTIFACT_NOT_FOUND',
              payload.outputRef ?? payload.artifactId!,
            );
        }
      }
      if ((type === 'image.comfy' || type === 'audio.ml-denoise') && assetId === undefined)
        throw new ControlPlaneError('ASSET_JOB_INVALID', 'Worker generation requires an asset ID');
      if ((type === 'image.comfy' || type === 'audio.ml-denoise') && assetId !== undefined) {
        await this.asset(actor, projectId, assetId, client);
        await lockAssetForJob(client, projectId, assetId);
      }
      try {
        const result = await client.query<JobRow>(
          `INSERT INTO jobs
             (id, project_id, type, asset_id, job_payload, job_requirements, idempotency_key,
              max_attempts, state, lease_owner, lease_expires_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, 'queued', NULL, NULL)
           RETURNING *`,
          [
            id,
            projectId,
            type,
            assetId ?? null,
            typedJob === undefined ? null : JSON.stringify(typedJob.payload),
            typedJob === undefined ? null : JSON.stringify(typedJob.requirements),
            typedJob?.idempotencyKey ?? null,
            typedJob?.maxAttempts ?? null,
          ],
        );
        const job = jobOf(requiredRow(result.rows[0], 'JOB_CREATE_FAILED'));
        await this.event(client, id, 'queued', now);
        return job;
      } catch (error) {
        throw databaseError(error, 'JOB_EXISTS', id);
      }
    });
  }

  async enqueueAssetThumbnail(
    actor: Actor,
    id: string,
    projectId: string,
    assetId: string,
    now = Date.now(),
  ): Promise<Job> {
    return this.transaction(async (client) => {
      await this.asset(actor, projectId, assetId, client);
      await lockAssetForJob(client, projectId, assetId);
      const existing = await client.query<JobRow>('SELECT * FROM jobs WHERE id = $1', [id]);
      if (existing.rows[0] !== undefined) return jobOf(existing.rows[0]);
      const typedJob = workerJobFor(id, projectId, 'asset.thumbnail', assetId);
      try {
        const result = await client.query<JobRow>(
          `INSERT INTO jobs
             (id, project_id, type, asset_id, job_payload, job_requirements, idempotency_key,
              max_attempts, state, lease_owner, lease_expires_at)
           VALUES ($1, $2, 'asset.thumbnail', $3, $4::jsonb, $5::jsonb, $6, $7,
              'queued', NULL, NULL)
           RETURNING *`,
          [
            id,
            projectId,
            assetId,
            JSON.stringify(typedJob!.payload),
            JSON.stringify(typedJob!.requirements),
            typedJob!.idempotencyKey,
            typedJob!.maxAttempts,
          ],
        );
        const job = jobOf(requiredRow(result.rows[0], 'JOB_CREATE_FAILED'));
        await this.event(client, id, 'queued', now);
        return job;
      } catch (error) {
        throw databaseError(error, 'JOB_EXISTS', id);
      }
    });
  }

  async lease(workerId: string, now = Date.now(), durationMs = 30_000): Promise<Job | undefined> {
    return this.transaction(async (client) => {
      const worker = await client.query<WorkerRow>(
        'SELECT * FROM workers WHERE id = $1 AND revoked_at IS NULL FOR UPDATE',
        [workerId],
      );
      if (worker.rows[0] === undefined)
        throw new ControlPlaneError('WORKER_UNAUTHORIZED', workerId);
      const workerRecord = workerOf(worker.rows[0]);
      const candidate = await client.query<JobRow>(
        `SELECT * FROM jobs
         WHERE asset_revoked = false
           AND (state = 'queued' OR (state = 'leased' AND lease_expires_at <= $1))
         ORDER BY id LIMIT 64 FOR UPDATE${this.#skipLocked ? ' SKIP LOCKED' : ''}`,
        [new Date(now)],
      );
      // Keep opaque-locality matching in the Worker/control-plane domain; this
      // also keeps the durable contract executable in pg-mem without changing
      // PostgreSQL's queue lock semantics.
      let job: JobRow | undefined;
      for (const item of candidate.rows) {
        const caps = workerRecord.capabilities;
        let compatible = false;
        if (item.type === 'asset.thumbnail') {
          compatible =
            item.asset_id !== null &&
            caps.includes('asset.thumbnail') &&
            workerRecord.localAssetIds.includes(item.asset_id);
        } else if (item.type === 'image.comfy') compatible = caps.includes('image.comfy');
        else if (item.type === 'audio.ml-denoise') compatible = caps.includes('audio.ml-denoise');
        else if (isWorkerJobType(item.type)) compatible = workerCanRunJob(caps, item.type);
        if (!compatible) continue;
        if (item.max_attempts !== null) {
          const attempts = await client.query<{ readonly count: number | string }>(
            'SELECT COUNT(*)::int AS count FROM job_attempts WHERE job_id = $1',
            [item.id],
          );
          const count = Number(attempts.rows[0]?.count ?? 0);
          if (count >= item.max_attempts) {
            const terminalState = item.cancel_requested ? 'canceled' : 'failed';
            await client.query(
              `UPDATE jobs SET state = $2, lease_owner = NULL, lease_expires_at = NULL,
                   cancel_requested = false, error = $3
               WHERE id = $1`,
              [
                item.id,
                terminalState,
                terminalState === 'failed' ? WORKER_ATTEMPT_BUDGET_EXHAUSTED : null,
              ],
            );
            await client.query(
              `UPDATE job_attempts SET completed_at = $2
               WHERE id = (SELECT id FROM job_attempts
                           WHERE job_id = $1 AND completed_at IS NULL
                           ORDER BY id DESC LIMIT 1)`,
              [item.id, new Date(now)],
            );
            await this.event(client, item.id, terminalState, now);
            continue;
          }
        }
        job = item;
        break;
      }
      if (job === undefined) return undefined;
      const result = await client.query<JobRow>(
        `UPDATE jobs SET state = 'leased', lease_owner = $2, lease_expires_at = $3,
             cancel_requested = false
         WHERE id = $1 RETURNING *`,
        [job.id, workerId, new Date(now + durationMs)],
      );
      await client.query(
        'INSERT INTO job_attempts (job_id, worker_id, started_at) VALUES ($1, $2, $3)',
        [job.id, workerId, new Date(now)],
      );
      await this.event(client, job.id, 'leased', now);
      return jobOf(requiredRow(result.rows[0], 'JOB_LEASE_FAILED'));
    });
  }

  async heartbeat(
    workerId: string,
    jobId: string,
    progress: number,
    now = Date.now(),
    durationMs = 30_000,
  ): Promise<{ readonly job: Job; readonly cancelRequested: boolean }> {
    if (!Number.isSafeInteger(progress) || progress < 0 || progress > 100)
      throw new ControlPlaneError('PROGRESS_INVALID', jobId);
    return this.transaction(async (client) => {
      const result = await client.query<JobRow>(
        `UPDATE jobs SET progress = $3, lease_expires_at = $4
         WHERE id = $1 AND state = 'leased' AND lease_owner = $2 AND lease_expires_at > $5
           AND progress <= $3
         RETURNING *`,
        [jobId, workerId, progress, new Date(now + durationMs), new Date(now)],
      );
      const job = result.rows[0];
      if (job === undefined) throw new ControlPlaneError('LEASE_NOT_OWNED', jobId);
      await client.query('UPDATE workers SET last_seen_at = $2 WHERE id = $1', [
        workerId,
        new Date(now),
      ]);
      await this.event(client, jobId, `progress:${progress}`, now);
      const value = jobOf(job);
      return { job: value, cancelRequested: value.cancelRequested };
    });
  }

  async complete(
    workerId: string,
    jobId: string,
    now = Date.now(),
    receipt?: WorkerResultReceipt,
  ): Promise<Job> {
    const leased = await this.pool.query<JobRow>(
      'SELECT * FROM jobs WHERE id = $1 AND state = $2 AND lease_owner = $3 AND lease_expires_at > $4',
      [jobId, 'leased', workerId, new Date(now)],
    );
    const leasedJob = leased.rows[0];
    if (leasedJob !== undefined && isWorkerJobType(leasedJob.type)) {
      try {
        validateWorkerReceiptForJob(leasedJob.type, receipt);
      } catch {
        throw new ControlPlaneError('RESULT_INVALID', jobId);
      }
    }
    if (receipt !== undefined && !isWorkerReceipt(receipt))
      throw new ControlPlaneError('RESULT_INVALID', jobId);
    if (leasedJob?.type === 'render.export') {
      if (receipt === undefined || !isRenderExportReceipt(receipt))
        throw new ControlPlaneError('RESULT_INVALID', jobId);
      const artifact = await this.pool.query<{ readonly id: string }>(
        `SELECT id FROM render_artifacts
         WHERE job_id = $1 AND output_ref = $2 AND sha256 = $3 AND byte_length = $4`,
        [jobId, receipt.outputRef, receipt.sha256, receipt.bytes],
      );
      if (artifact.rows[0] === undefined) throw new ControlPlaneError('RESULT_INVALID', jobId);
    }
    if (leasedJob?.type === 'render.inspect') {
      const payload = jsonObject(leasedJob.job_payload);
      const artifactBacked = 'artifactId' in payload;
      if (
        artifactBacked &&
        (receipt?.kind !== 'render.inspect' ||
          receipt.outputRef === undefined ||
          receipt.report === undefined)
      )
        throw new ControlPlaneError('RESULT_INVALID', jobId);
      if (
        !artifactBacked &&
        (payload.legacyVersion !== 0 ||
          receipt?.kind !== 'render.inspect' ||
          receipt.findings === undefined)
      )
        throw new ControlPlaneError('RESULT_INVALID', jobId);
      if (!artifactBacked) {
        // Explicit legacyVersion=0 jobs retain their historical count receipt.
      } else {
        const inspectReceipt = receipt as Extract<
          WorkerResultReceipt,
          { readonly kind: 'render.inspect' }
        >;
        const artifact = await this.pool.query<{ readonly id: string }>(
          `SELECT artifacts.id FROM render_artifacts AS artifacts
         JOIN jobs AS exported ON exported.id = artifacts.job_id
         WHERE artifacts.id = $1 AND artifacts.project_id = $2
           AND artifacts.output_ref = $3
           AND artifacts.sha256 = $4 AND artifacts.byte_length = $5
           AND exported.state = 'completed' AND exported.type = 'render.export'
           AND exported.result_sha256 = artifacts.sha256
           AND exported.result_bytes = artifacts.byte_length
           AND exported.result_receipt->>'outputRef' = artifacts.output_ref`,
          [
            payload.artifactId,
            leasedJob.project_id,
            inspectReceipt.outputRef,
            inspectReceipt.report!.artifact?.sha256,
            inspectReceipt.report!.artifact?.bytes,
          ],
        );
        if (artifact.rows[0] === undefined) throw new ControlPlaneError('RESULT_INVALID', jobId);
      }
    }
    const isThumb = receipt?.kind === 'asset.thumbnail';
    const isGpu = receipt?.kind === 'image.comfy' || receipt?.kind === 'audio.ml-denoise';
    const isMediaAi = receipt?.kind === 'video.runway' || receipt?.kind === 'edit.higgsfield';
    const storesAsset = isThumb || isGpu || isMediaAi;
    const storesHashAndBytes = receipt !== undefined && 'sha256' in receipt && 'bytes' in receipt;
    const storesDescriptor = storesAsset && receipt !== undefined && 'descriptor' in receipt;
    return this.transaction(async (client) => {
      if (leasedJob?.asset_id !== null && leasedJob?.asset_id !== undefined) {
        const asset = await client.query<{ readonly id: string }>(
          'SELECT id FROM media_assets WHERE id = $1 AND project_id = $2 FOR SHARE',
          [leasedJob.asset_id, leasedJob.project_id],
        );
        if (asset.rows[0] === undefined) throw new ControlPlaneError('LEASE_NOT_OWNED', jobId);
      }
      const result = await client.query<JobRow>(
        `UPDATE jobs SET state = 'completed', progress = 100, cancel_requested = false,
             result_kind = $4, result_sha256 = $5, result_bytes = $6,
             result_ref = $7, result_worker_ref = $8, result_verified_at = $9,
             result_asset_id = $10, result_local_ref = $11, result_mime_type = $12,
             result_width = $13, result_height = $14, result_receipt = $15::jsonb
         WHERE id = $1 AND state = 'leased' AND lease_owner = $2 AND lease_expires_at > $3
           AND cancel_requested = false AND asset_revoked = false
           AND (type <> 'asset.thumbnail' OR ($4 = 'asset.thumbnail' AND asset_id = $10))
           AND (type <> 'image.comfy' OR $4 = 'image.comfy')
           AND (type <> 'audio.ml-denoise' OR $4 = 'audio.ml-denoise')
           AND (type NOT IN ('render.export', 'render.inspect', 'text.lm-studio', 'text.openrouter',
                             'video.runway', 'edit.higgsfield', 'video.reference-analyze') OR type = $4)
         RETURNING *`,
        [
          jobId,
          workerId,
          new Date(now),
          receipt?.kind ?? null,
          storesHashAndBytes ? receipt.sha256 : null,
          storesHashAndBytes ? receipt.bytes : null,
          receipt === undefined ? null : `derivative:${jobId}`,
          receipt === undefined ? null : workerId,
          receipt === undefined ? null : new Date(now),
          storesAsset && receipt !== undefined && 'assetId' in receipt ? receipt.assetId : null,
          storesAsset && receipt !== undefined && 'localRef' in receipt ? receipt.localRef : null,
          storesDescriptor ? receipt.descriptor.mimeType : null,
          isThumb && receipt?.kind === 'asset.thumbnail'
            ? receipt.descriptor.width
            : (isGpu || isMediaAi) && storesDescriptor
              ? (receipt.descriptor.width ?? null)
              : null,
          isThumb && receipt?.kind === 'asset.thumbnail'
            ? receipt.descriptor.height
            : (isGpu || isMediaAi) && storesDescriptor
              ? (receipt.descriptor.height ?? null)
              : null,
          receipt === undefined ? null : JSON.stringify(receipt),
        ],
      );
      if (result.rows[0] === undefined) throw new ControlPlaneError('LEASE_NOT_OWNED', jobId);
      await client.query(
        `UPDATE job_attempts SET completed_at = $3
         WHERE id = (SELECT id FROM job_attempts WHERE job_id = $1 AND worker_id = $2
                     ORDER BY id DESC LIMIT 1)`,
        [jobId, workerId, new Date(now)],
      );
      await this.event(client, jobId, 'completed', now);
      return jobOf(result.rows[0]);
    });
  }

  async fail(workerId: string, jobId: string, error: string, now = Date.now()): Promise<Job> {
    return this.transaction(async (client) => {
      const result = await client.query<JobRow>(
        `UPDATE jobs SET state = CASE WHEN $4 = 'canceled' THEN 'canceled' ELSE 'failed' END,
             cancel_requested = false, error = CASE WHEN $4 = 'canceled' THEN NULL ELSE $4 END
         WHERE id = $1 AND state = 'leased' AND lease_owner = $2 AND lease_expires_at > $3
         RETURNING *`,
        [jobId, workerId, new Date(now), error.slice(0, 500)],
      );
      if (result.rows[0] === undefined) throw new ControlPlaneError('LEASE_NOT_OWNED', jobId);
      await this.event(client, jobId, error === 'canceled' ? 'canceled' : 'failed', now);
      return jobOf(result.rows[0]);
    });
  }

  async cancel(actor: Actor, projectId: string, jobId: string, now = Date.now()): Promise<Job> {
    return this.transaction(async (client) => {
      await this.project(actor, projectId, client);
      const result = await client.query<JobRow>(
        `UPDATE jobs SET state = CASE WHEN state = 'queued' THEN 'canceled' ELSE state END,
             cancel_requested = CASE WHEN state = 'leased' THEN true ELSE cancel_requested END
         WHERE id = $1 AND project_id = $2 AND state IN ('queued', 'leased') RETURNING *`,
        [jobId, projectId],
      );
      const job = result.rows[0];
      if (job === undefined) throw new ControlPlaneError('JOB_NOT_CANCELABLE', jobId);
      await this.event(client, jobId, job.cancel_requested ? 'cancel-requested' : 'canceled', now);
      return jobOf(job);
    });
  }

  async retry(actor: Actor, projectId: string, jobId: string, now = Date.now()): Promise<Job> {
    return this.transaction(async (client) => {
      await this.project(actor, projectId, client);
      const result = await client.query<JobRow>(
        `UPDATE jobs SET state = 'queued', progress = 0, cancel_requested = false,
             lease_owner = NULL, lease_expires_at = NULL, result_kind = NULL,
             result_sha256 = NULL, result_bytes = NULL, result_ref = NULL,
             result_worker_ref = NULL, result_verified_at = NULL, result_asset_id = NULL,
             result_local_ref = NULL, result_mime_type = NULL, result_width = NULL,
             result_height = NULL, result_receipt = NULL, error = NULL
         WHERE id = $1 AND project_id = $2 AND asset_revoked = false
           AND state IN ('completed', 'canceled', 'failed')
         RETURNING *`,
        [jobId, projectId],
      );
      if (result.rows[0] === undefined) throw new ControlPlaneError('JOB_NOT_RETRYABLE', jobId);
      await client.query('DELETE FROM render_artifacts WHERE job_id = $1', [jobId]);
      await this.event(client, jobId, 'retried', now);
      return jobOf(result.rows[0]);
    });
  }

  async jobsForProject(actor: Actor, projectId: string): Promise<readonly Job[]> {
    await this.project(actor, projectId);
    const result = await this.pool.query<JobRow>(
      'SELECT * FROM jobs WHERE project_id = $1 ORDER BY id',
      [projectId],
    );
    return result.rows.map(jobOf);
  }

  async workersForOwner(actor: Actor): Promise<readonly WorkerRecord[]> {
    assertActor(actor);
    const result = await this.pool.query<WorkerRow>(
      'SELECT * FROM workers WHERE owner_id = $1 ORDER BY id',
      [actor.id],
    );
    return result.rows.map(workerOf);
  }

  async eventsAfter(actor: Actor, projectId: string, cursor: number): Promise<readonly JobEvent[]> {
    await this.project(actor, projectId);
    const result = await this.pool.query<EventRow>(
      `SELECT event.cursor, event.job_id, event.type, event.created_at
       FROM job_events AS event JOIN jobs ON jobs.id = event.job_id
       WHERE jobs.project_id = $1 AND event.cursor > $2 ORDER BY event.cursor`,
      [projectId, cursor],
    );
    return result.rows.map((event) => ({
      cursor: Number(event.cursor),
      jobId: event.job_id,
      type: event.type,
      at: event.created_at.getTime(),
    }));
  }

  async createProductionRun(
    actor: Actor,
    projectId: string,
    input: CreateProductionRunInput,
  ): Promise<ProductionRunRecordV1> {
    return this.#productionRuns.createProductionRun(actor, projectId, input);
  }

  async listProductionRuns(
    actor: Actor,
    projectId: string,
    options?: ListProductionRunsOptions,
  ): Promise<ProductionRunPage> {
    return this.#productionRuns.listProductionRuns(actor, projectId, options);
  }

  async getProductionRun(
    actor: Actor,
    projectId: string,
    runId: string,
  ): Promise<ProductionRunRecordV1> {
    return this.#productionRuns.getProductionRun(actor, projectId, runId);
  }

  async respondToProductionApproval(
    actor: Actor,
    projectId: string,
    runId: string,
    input: RespondToProductionApprovalInput,
  ): Promise<ProductionApprovalResponseResult> {
    return this.#productionRuns.respondToProductionApproval(actor, projectId, runId, input);
  }

  async cancelProductionRun(
    actor: Actor,
    projectId: string,
    runId: string,
    input: CancelProductionRunInput,
  ): Promise<ProductionRunRecordV1> {
    return this.#productionRuns.cancelProductionRun(actor, projectId, runId, input);
  }

  private async project(
    actor: Actor,
    id: string,
    client: Pool | PoolClient = this.pool,
  ): Promise<ProjectMetadata> {
    assertActor(actor);
    const result = await client.query<ProjectRow>(
      'SELECT * FROM projects WHERE id = $1 AND owner_id = $2',
      [id, actor.id],
    );
    if (result.rows[0] === undefined) throw new ControlPlaneError('PROJECT_NOT_FOUND', id);
    return projectOf(result.rows[0]);
  }

  private async asset(
    actor: Actor,
    projectId: string,
    assetId: string,
    client: Pool | PoolClient = this.pool,
  ): Promise<void> {
    await this.project(actor, projectId, client);
    const result = await client.query<{ readonly id: string }>(
      'SELECT id FROM media_assets WHERE id = $1 AND project_id = $2',
      [assetId, projectId],
    );
    if (result.rows[0] === undefined) throw new ControlPlaneError('ASSET_NOT_FOUND', assetId);
  }

  private async event(client: PoolClient, jobId: string, type: string, at: number): Promise<void> {
    await client.query('INSERT INTO job_events (job_id, type, created_at) VALUES ($1, $2, $3)', [
      jobId,
      type,
      new Date(at),
    ]);
  }

  private async purgeAssetReferences(
    projectId: string,
    assetId: string,
    revokeId: number | undefined,
    refs: readonly string[],
  ): Promise<void> {
    let failed = false;
    for (const ref of refs) {
      try {
        await this.#privateObjectStore!.remove(ref);
      } catch {
        // Object-store errors are intentionally redacted: refs are opaque but
        // must never be echoed through API errors or logs.
        failed = true;
      }
    }
    if (revokeId === undefined) return;
    await this.pool.query(
      `UPDATE asset_revocation_audits
       SET purge_state = $3, purge_error = $4, purged_at = CASE WHEN $3 = 'complete' THEN NOW() ELSE NULL END,
           updated_at = NOW()
       WHERE revoke_id = $5 AND project_id = $1 AND asset_id = $2`,
      [
        projectId,
        assetId,
        failed ? 'failed' : 'complete',
        failed ? 'OBJECT_PURGE_FAILED' : null,
        revokeId,
      ],
    );
    if (!failed)
      await this.pool.query(
        `UPDATE private_object_cleanup_refs SET state = 'cleaned', last_error = NULL,
           cleaned_at = NOW(), updated_at = NOW()
         WHERE project_id = $1 AND revocation_id = $3 AND state IN ('pending', 'registered')`,
        [projectId, assetId, revokeId],
      );
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

function assertActor(actor: Actor): void {
  if (actor.id.length === 0)
    throw new ControlPlaneError('AUTH_REQUIRED', 'actor identity required');
}

function requiredRow<T>(row: T | undefined, code: string): T {
  if (row === undefined) throw new ControlPlaneError(code, 'database did not return a row');
  return row;
}

function projectOf(row: ProjectRow): ProjectMetadata {
  return {
    id: row.id,
    ownerId: row.owner_id,
    title: row.title,
    revision: row.revision,
    assetSyncEnabled: row.asset_sync_enabled,
  };
}

function workerOf(row: WorkerRow): WorkerRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    paired: row.revoked_at === null,
    revoked: row.revoked_at !== null,
    capabilities: row.capabilities,
    localAssetIds: row.local_asset_ids,
    ...(row.last_seen_at === null ? {} : { lastSeenAt: row.last_seen_at.getTime() }),
  };
}

function jobOf(row: JobRow): Job {
  return {
    id: row.id,
    projectId: row.project_id,
    type: row.type,
    ...(row.asset_id === null ? {} : { assetId: row.asset_id }),
    ...typedJobFieldsOf(row),
    state: row.state,
    progress: row.progress,
    cancelRequested: row.cancel_requested,
    ...(row.lease_owner === null ? {} : { leaseOwner: row.lease_owner }),
    ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: row.lease_expires_at.getTime() }),
    ...(!isWorkerJobType(row.type) ||
    row.result_kind === null ||
    row.result_ref === null ||
    row.result_worker_ref === null ||
    row.result_verified_at === null
      ? {}
      : {
          derivative: derivativeOfRow(row),
        }),
    ...(row.error === null ? {} : { error: row.error }),
  };
}

function derivativeOfRow(row: JobRow): NonNullable<Job['derivative']> {
  const base: {
    readonly jobId: string;
    readonly resultRef: string;
    readonly workerRef: string;
    readonly verifiedAt: number;
  } = {
    jobId: row.id,
    resultRef: row.result_ref!,
    workerRef: row.result_worker_ref!,
    verifiedAt: row.result_verified_at!.getTime(),
  };
  if (row.result_receipt !== null && row.result_receipt !== undefined) {
    const receipt = workerReceiptOf(row.result_receipt);
    return { ...base, ...receipt };
  }
  const hashAndBytes = resultHashAndBytesOf(row);
  if (
    row.result_kind === 'asset.thumbnail' &&
    row.result_asset_id !== null &&
    row.result_local_ref !== null &&
    row.result_mime_type === 'image/jpeg' &&
    row.result_width !== null &&
    row.result_height !== null
  ) {
    return {
      ...base,
      ...hashAndBytes,
      kind: row.result_kind,
      assetId: row.result_asset_id,
      localRef: row.result_local_ref,
      descriptor: { mimeType: 'image/jpeg', width: row.result_width, height: row.result_height },
    };
  }
  if (
    (row.result_kind === 'image.comfy' || row.result_kind === 'audio.ml-denoise') &&
    row.result_asset_id !== null &&
    row.result_local_ref !== null &&
    row.result_mime_type !== null
  ) {
    return {
      ...base,
      ...hashAndBytes,
      kind: row.result_kind,
      assetId: row.result_asset_id,
      localRef: row.result_local_ref,
      descriptor: {
        mimeType: row.result_mime_type,
        ...(row.result_width === null ? {} : { width: row.result_width }),
        ...(row.result_height === null ? {} : { height: row.result_height }),
      },
    };
  }
  throw new ControlPlaneError('DATABASE_ERROR', 'stored Worker result is invalid');
}

function resultHashAndBytesOf(row: JobRow): { readonly sha256: string; readonly bytes: number } {
  if (row.result_sha256 === null || row.result_bytes === null)
    throw new ControlPlaneError('DATABASE_ERROR', 'stored Worker result is invalid');
  return { sha256: row.result_sha256, bytes: row.result_bytes };
}

function typedJobFieldsOf(
  row: JobRow,
): Pick<Job, 'payload' | 'requirements' | 'idempotencyKey' | 'maxAttempts'> {
  if (
    row.job_payload === null ||
    row.job_payload === undefined ||
    row.job_requirements === null ||
    row.job_requirements === undefined ||
    row.idempotency_key === null ||
    row.max_attempts === null
  ) {
    return {};
  }
  return {
    payload: jsonObject(row.job_payload) as WorkerJobV1['payload'],
    requirements: jsonObject(row.job_requirements) as WorkerJobV1['requirements'],
    idempotencyKey: row.idempotency_key,
    maxAttempts: row.max_attempts,
  };
}

function workerReceiptOf(value: unknown): WorkerResultReceipt {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new ControlPlaneError('DATABASE_ERROR', 'stored Worker result is invalid');
  const receipt = value as WorkerResultReceipt;
  if (!isWorkerReceipt(receipt))
    throw new ControlPlaneError('DATABASE_ERROR', 'stored Worker result is invalid');
  return receipt;
}

function mediaAssetOf(row: MediaAssetRow): MediaAssetRecord {
  const tagsRaw = row.tags === undefined || row.tags === null ? [] : jsonArray(row.tags);
  const tags = tagsRaw.filter((item): item is string => typeof item === 'string');
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    displayName: row.display_name,
    sha256: row.sha256,
    bytes: safeByteLength(row.byte_length),
    descriptor: jsonObject(row.descriptor) as unknown as MediaAssetRecord['descriptor'],
    locations: jsonArray(row.locations) as MediaAssetRecord['locations'],
    tags,
    sortName:
      typeof row.sort_name === 'string' && row.sort_name.length > 0
        ? row.sort_name
        : row.display_name.trim().toLocaleLowerCase(),
    createdAt: row.created_at.getTime(),
  };
}

function mediaDerivativeOf(row: MediaDerivativeRow): MediaDerivativeRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    assetId: row.asset_id,
    kind: row.kind,
    profile: row.profile,
    sha256: row.sha256,
    bytes: safeByteLength(row.byte_length),
    descriptor: jsonObject(row.descriptor) as unknown as MediaDerivativeRecord['descriptor'],
    availability: row.availability,
    locations: jsonArray(row.locations) as MediaDerivativeRecord['locations'],
    verifiedAt: row.verified_at.getTime(),
  };
}

function renderArtifactOf(row: RenderArtifactRow): RenderArtifactRecord {
  const descriptor = jsonObject(row.descriptor);
  if (descriptor.mimeType !== 'video/mp4')
    throw new ControlPlaneError('DATABASE_ERROR', 'stored render artifact MIME is invalid');
  const location = jsonObject(row.location);
  if (location.kind !== 'private-object' || typeof location.ref !== 'string')
    throw new ControlPlaneError('DATABASE_ERROR', 'stored render artifact location is invalid');
  return {
    id: row.id,
    projectId: row.project_id,
    jobId: row.job_id,
    outputRef: row.output_ref,
    sha256: row.sha256,
    bytes: safeByteLength(row.byte_length),
    descriptor: { mimeType: 'video/mp4' },
    location: { kind: 'private-object', ref: location.ref },
    verifiedAt: row.verified_at.getTime(),
  };
}

function safeByteLength(value: string | number): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1)
    throw new ControlPlaneError('DATABASE_ERROR', 'stored media byte length is invalid');
  return result;
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new ControlPlaneError('DATABASE_ERROR', 'stored media descriptor is invalid');
  return value as Record<string, unknown>;
}

function jsonArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value))
    throw new ControlPlaneError('DATABASE_ERROR', 'stored media locations are invalid');
  return value;
}

function isWorkerReceipt(value: WorkerResultReceipt): boolean {
  return (
    isAssetThumbnailReceipt(value) ||
    isLocalGpuReceipt(value) ||
    isTextAiReceipt(value) ||
    isMediaAiReceipt(value) ||
    isReferenceAnalysisReceipt(value) ||
    isSemanticIndexReceipt(value) ||
    isRenderReceipt(value)
  );
}

function isAssetThumbnailReceipt(value: WorkerResultReceipt): value is AssetThumbnailReceipt {
  return (
    value.kind === 'asset.thumbnail' &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.assetId) &&
    /^[a-f0-9]{64}$/.test(value.sha256) &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes > 100 &&
    /^thumb-[A-Za-z0-9._-]{1,110}$/.test(value.localRef) &&
    value.descriptor.mimeType === 'image/jpeg' &&
    Number.isSafeInteger(value.descriptor.width) &&
    value.descriptor.width > 0 &&
    Number.isSafeInteger(value.descriptor.height) &&
    value.descriptor.height > 0
  );
}

function isLocalGpuReceipt(value: WorkerResultReceipt): value is LocalGpuWorkerReceipt {
  return (
    (value.kind === 'image.comfy' || value.kind === 'audio.ml-denoise') &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.assetId) &&
    /^[a-f0-9]{64}$/.test(value.sha256) &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes > 0 &&
    /^gpu-[A-Za-z0-9._-]{1,110}$/.test(value.localRef) &&
    typeof value.descriptor.mimeType === 'string' &&
    value.descriptor.mimeType.length > 0
  );
}

function isTextAiReceipt(
  value: WorkerResultReceipt,
): value is Extract<WorkerResultReceipt, { readonly kind: 'text.lm-studio' | 'text.openrouter' }> {
  return (
    (value.kind === 'text.lm-studio' || value.kind === 'text.openrouter') &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.resultRef) &&
    /^[a-f0-9]{64}$/.test(value.sha256) &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes > 0 &&
    (value.model === undefined || typeof value.model === 'string')
  );
}

function isMediaAiReceipt(
  value: WorkerResultReceipt,
): value is Extract<WorkerResultReceipt, { readonly kind: 'video.runway' | 'edit.higgsfield' }> {
  return (
    (value.kind === 'video.runway' || value.kind === 'edit.higgsfield') &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.assetId) &&
    /^[a-f0-9]{64}$/.test(value.sha256) &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes > 0 &&
    /^ai-[A-Za-z0-9._-]{1,110}$/.test(value.localRef) &&
    typeof value.descriptor.mimeType === 'string' &&
    value.descriptor.mimeType.length > 0 &&
    (value.model === undefined || typeof value.model === 'string')
  );
}

function isReferenceAnalysisReceipt(
  value: WorkerResultReceipt,
): value is VideoReferenceAnalyzeReceipt {
  return (
    value.kind === 'video.reference-analyze' &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.assetId) &&
    /^[a-f0-9]{64}$/.test(value.sha256) &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes > 0 &&
    typeof value.descriptor.mimeType === 'string' &&
    value.descriptor.mimeType.startsWith('video/') &&
    Number.isSafeInteger(value.descriptor.width) &&
    value.descriptor.width > 0 &&
    Number.isSafeInteger(value.descriptor.height) &&
    value.descriptor.height > 0 &&
    Number.isSafeInteger(value.descriptor.durationUs) &&
    value.descriptor.durationUs > 0 &&
    Array.isArray(value.evidence) &&
    Array.isArray(value.evidenceIds) &&
    (value.findings === undefined || Array.isArray(value.findings)) &&
    (value.model === undefined || typeof value.model === 'string')
  );
}

function isSemanticIndexReceipt(value: WorkerResultReceipt): value is SemanticIndexWorkerReceipt {
  if (value.kind !== 'media.semantic-index') return false;
  try {
    validateWorkerReceiptForJob('media.semantic-index', value);
    return true;
  } catch {
    return false;
  }
}

function isRenderReceipt(value: WorkerResultReceipt): boolean {
  if (value.kind === 'render.export') {
    return (
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.reportRef) &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.outputRef) &&
      /^[a-f0-9]{64}$/.test(value.sha256) &&
      Number.isSafeInteger(value.bytes) &&
      value.bytes > 0
    );
  }
  return (
    value.kind === 'render.inspect' &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.reportRef) &&
    ((value.outputRef === undefined &&
      value.report === undefined &&
      Number.isSafeInteger(value.findings) &&
      value.findings! >= 0) ||
      (value.outputRef !== undefined &&
        value.report !== undefined &&
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.outputRef) &&
        value.report.version === 1 &&
        value.report.artifact?.outputRef === value.outputRef &&
        Array.isArray(value.report.findings)))
  );
}

function isRenderExportReceipt(
  value: WorkerResultReceipt,
): value is Extract<WorkerResultReceipt, { readonly kind: 'render.export' }> {
  return (
    value.kind === 'render.export' &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.reportRef) &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.outputRef) &&
    /^[a-f0-9]{64}$/.test(value.sha256) &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes > 0
  );
}

function normalizeOpaqueAssetIds(values: readonly string[]): readonly string[] {
  if (
    values.length > 1_000 ||
    values.some((value) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value))
  ) {
    throw new ControlPlaneError('WORKER_ASSETS_INVALID', 'Worker asset IDs must be opaque');
  }
  return [...new Set(values)].sort();
}

function workerJobFor(
  id: string,
  projectId: string,
  type: string,
  assetId?: string,
  workerJob?: WorkerJobV1,
): WorkerJobV1 | undefined {
  if (!isWorkerJobType(type)) return undefined;
  if (workerJob !== undefined) {
    if (workerJob.jobId !== id || workerJob.type !== type)
      throw new ControlPlaneError('WORKER_JOB_INVALID', 'Worker job envelope does not match');
    try {
      return validateWorkerJobV1(workerJob);
    } catch {
      throw new ControlPlaneError('WORKER_JOB_INVALID', 'Worker job envelope is invalid');
    }
  }
  return legacyWorkerJob(id, projectId, type, assetId);
}

function legacyWorkerJob(
  id: string,
  projectId: string,
  type: string,
  assetId?: string,
): WorkerJobV1 | undefined {
  if (!isWorkerJobType(type)) return undefined;
  if (type === 'asset.thumbnail') {
    if (assetId === undefined)
      throw new ControlPlaneError(
        'ASSET_JOB_INVALID',
        'asset thumbnail requires an opaque asset ID',
      );
    return validateWorkerJobV1({
      protocolVersion: WORKER_PROTOCOL_VERSION,
      jobId: id,
      type,
      payload: { assetId, maxEdgePx: 720 },
      requirements: { capabilities: ['asset.thumbnail'], privacy: 'local-only' },
      idempotencyKey: id,
      maxAttempts: 3,
    });
  }
  if (type === 'render.export') {
    return validateWorkerJobV1({
      protocolVersion: WORKER_PROTOCOL_VERSION,
      jobId: id,
      type,
      payload: {
        projectRef: projectId,
        compositionId: id,
        presetId: 'default',
        reportRef: `report-${id}`,
      },
      requirements: { capabilities: [type], privacy: 'local-only' },
      idempotencyKey: id,
      maxAttempts: 3,
    });
  }
  if (type === 'render.inspect') {
    return validateWorkerJobV1({
      protocolVersion: WORKER_PROTOCOL_VERSION,
      jobId: id,
      type,
      payload: {
        projectRef: projectId,
        compositionId: id,
        presetId: 'default',
        reportRef: `report-${id}`,
        legacyVersion: 0,
      },
      requirements: { capabilities: [type], privacy: 'local-only' },
      idempotencyKey: id,
      maxAttempts: 3,
    });
  }
  if (type === 'media.semantic-index') {
    return validateWorkerJobV1({
      protocolVersion: WORKER_PROTOCOL_VERSION,
      jobId: id,
      type,
      payload: {
        projectId,
        receipts: [],
      },
      requirements: { capabilities: ['media.semantic-index'], privacy: 'local-only' },
      idempotencyKey: id,
      maxAttempts: 3,
    });
  }
  const aiType = type as Exclude<
    WorkerJobType,
    | 'asset.thumbnail'
    | 'video.reference-analyze'
    | 'media.semantic-index'
    | 'render.export'
    | 'render.inspect'
  >;
  return validateWorkerJobV1({
    protocolVersion: WORKER_PROTOCOL_VERSION,
    jobId: id,
    type: aiType,
    payload: {
      prompt: '',
      ...(assetId === undefined ? {} : { imageAssetId: assetId }),
    },
    requirements: {
      capabilities: [aiType],
      privacy:
        aiType === 'text.openrouter' || aiType === 'video.runway' || aiType === 'edit.higgsfield'
          ? 'remote-api'
          : 'local-only',
    },
    idempotencyKey: id,
    maxAttempts: 3,
  });
}

function databaseError(error: unknown, duplicateCode: string, id: string): ControlPlaneError {
  if (isPostgresError(error) && error.code === '23505')
    return new ControlPlaneError(duplicateCode, id);
  if (error instanceof ControlPlaneError) return error;
  return new ControlPlaneError('DATABASE_ERROR', 'durable control-plane operation failed');
}

async function recordObjectReferences(
  client: PoolClient,
  projectId: string,
  assetId: string,
  derivativeId: string | undefined,
  locations: readonly AssetLocationRecord[],
  now: number,
): Promise<void> {
  for (const ref of privateObjectRefs(locations)) {
    await client.query(
      `INSERT INTO asset_object_references
         (project_id, asset_id, derivative_id, object_kind, object_ref, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        projectId,
        assetId,
        derivativeId ?? null,
        derivativeId === undefined ? 'original' : 'derivative',
        ref,
        new Date(now),
      ],
    );
  }
}

async function insertCleanupReference(
  client: PoolClient,
  projectId: string,
  assetId: string | null,
  jobId: string | undefined,
  objectKind: 'original' | 'derivative' | 'artifact',
  objectRef: string,
): Promise<void> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(objectRef))
    throw new ControlPlaneError('ASSET_INVALID', 'object reference must be opaque');
  await client.query(
    `INSERT INTO private_object_cleanup_refs
       (project_id, asset_id, job_id, object_kind, object_ref, state, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'pending', NOW(), NOW())`,
    [projectId, assetId, jobId ?? null, objectKind, objectRef],
  );
}

function privateObjectRefs(locations: readonly AssetLocationRecord[]): readonly string[] {
  return locations
    .filter(
      (location): location is AssetLocationRecord & { readonly kind: 'private-object' } =>
        location.kind === 'private-object',
    )
    .map((location) => location.ref);
}

async function lockAssetForJob(
  client: PoolClient,
  projectId: string,
  assetId: string,
): Promise<void> {
  const result = await client.query<{ readonly id: string }>(
    'SELECT id FROM media_assets WHERE id = $1 AND project_id = $2 FOR SHARE',
    [assetId, projectId],
  );
  if (result.rows[0] === undefined) throw new ControlPlaneError('ASSET_NOT_FOUND', assetId);
}

function uniqueOpaqueRefs(refs: readonly string[]): readonly string[] {
  return [...new Set(refs)].filter((ref) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(ref)).sort();
}

function assetRevocationAuditOf(row: AssetRevocationAuditRow): AssetRevocationAudit {
  const assetSnapshot = cloneJson(row.asset_snapshot as MediaAssetRecord);
  const derivativesRaw = jsonArray(row.derivative_snapshot);
  const derivativeSnapshot = derivativesRaw.map((value) => {
    const item = value as MediaDerivativeRecord;
    return cloneJson(item);
  });
  const refs = jsonArray(row.object_refs).filter(
    (value): value is string => typeof value === 'string',
  );
  const canceledJobIds = jsonArray(row.canceled_job_ids).filter(
    (value): value is string => typeof value === 'string',
  );
  return {
    revokeId: Number(row.revoke_id),
    projectId: row.project_id,
    assetId: row.asset_id,
    actorId: row.actor_id,
    assetSnapshot: cloneJson(assetSnapshot),
    derivativeSnapshot,
    objectRefs: refs,
    canceledJobIds,
    purgeState: row.purge_state,
    ...(row.purge_error === null ? {} : { purgeError: row.purge_error }),
    requestedAt: row.requested_at.toISOString(),
    ...(row.purged_at === null ? {} : { purgedAt: row.purged_at.toISOString() }),
    updatedAt: row.updated_at.toISOString(),
  };
}

function isPostgresError(value: unknown): value is { readonly code: string } {
  return (
    value !== null && typeof value === 'object' && 'code' in value && typeof value.code === 'string'
  );
}

function parseProjectDocument(value: unknown): ProjectDocumentV2 {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      throw new ControlPlaneError('DATABASE_ERROR', 'stored project document is invalid');
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new ControlPlaneError('DATABASE_ERROR', 'stored project document is invalid');
  const diagnostics = validateProjectDocumentV2(value);
  if (diagnostics.length > 0)
    throw new ControlPlaneError('DATABASE_ERROR', 'stored project document is invalid');
  const document = value as ProjectDocumentV2;
  return JSON.parse(JSON.stringify(document)) as ProjectDocumentV2;
}

function validateProjectDocumentV2Safe(value: unknown): ControlPlaneError | undefined {
  const diagnostics = validateProjectDocumentV2(value);
  return diagnostics.length === 0
    ? undefined
    : new ControlPlaneError('REQUEST_INVALID', diagnostics[0]!.message);
}

function cloneProjectDocument(value: ProjectDocumentV2): ProjectDocumentV2 {
  return JSON.parse(JSON.stringify(value)) as ProjectDocumentV2;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function recoveryRequestFingerprint(input: CreateRecoveredCopyInput): string {
  const operation = input.operation;
  const requestedHash =
    operation.kind === 'append'
      ? documentHash(operation.document)
      : `revision:${String(operation.targetRevision)}`;
  return `${String(input.baseRevision)}:${input.suggestedName}:${operation.kind}:${requestedHash}:${operation.label ?? ''}`;
}

function parseRecoveredCopy(value: unknown): RecoveredCopy {
  let candidate = value;
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      throw new ControlPlaneError('DATABASE_ERROR', 'stored recovered copy is invalid');
    }
  }
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate))
    throw invalidStoredRecoveredCopy();
  const result = candidate as Record<string, unknown>;
  if (result.kind !== 'recovered-copy' || !isStoredRecord(result.provenance))
    throw invalidStoredRecoveredCopy();
  const projectId = storedRecoveryString(result.projectId);
  const document = parseProjectDocument(result.document);
  if (document.projectId !== projectId) throw invalidStoredRecoveredCopy();
  const provenance = result.provenance;
  const operation = storedRecoveredOperation(provenance.operation);
  return {
    kind: 'recovered-copy',
    projectId,
    name: storedRecoveryString(result.name),
    document,
    basedOnRevision: storedRecoveryNonNegativeInteger(result.basedOnRevision),
    serverRevision: storedRecoveryPositiveInteger(result.serverRevision),
    createdAt: storedRecoveryString(result.createdAt),
    provenance: {
      sourceProjectId: storedRecoveryString(provenance.sourceProjectId),
      baseRevision: storedRecoveryNonNegativeInteger(provenance.baseRevision),
      sourceHeadRevision: storedRecoveryNonNegativeInteger(provenance.sourceHeadRevision),
      operation,
      requestedDocumentHash: storedRecoveryString(provenance.requestedDocumentHash),
    },
  };
}

function storedRecoveredOperation(value: unknown): RecoveredCopyProvenance['operation'] {
  if (!isStoredRecord(value)) throw invalidStoredRecoveredCopy();
  const label = value.label === undefined ? undefined : storedRecoveryString(value.label);
  if (value.kind === 'append') {
    return {
      kind: 'append',
      document: parseProjectDocument(value.document),
      ...(label === undefined ? {} : { label }),
    };
  }
  if (value.kind === 'restore') {
    return {
      kind: 'restore',
      targetRevision: storedRecoveryPositiveInteger(value.targetRevision),
      ...(label === undefined ? {} : { label }),
    };
  }
  throw invalidStoredRecoveredCopy();
}

function isStoredRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function storedRecoveryString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw invalidStoredRecoveredCopy();
  return value;
}

function storedRecoveryNonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalidStoredRecoveredCopy();
  return value as number;
}

function storedRecoveryPositiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw invalidStoredRecoveredCopy();
  return value as number;
}

function invalidStoredRecoveredCopy(): ControlPlaneError {
  return new ControlPlaneError('DATABASE_ERROR', 'stored recovered copy is invalid');
}

function projectRevisionOf(row: ProjectRevisionRow): ProjectRevisionV1 {
  const operation = row.operation;
  if (operation === null || typeof operation !== 'object' || Array.isArray(operation))
    throw new ControlPlaneError('DATABASE_ERROR', 'stored project operation is invalid');
  const operationRecord = operation as Record<string, unknown>;
  const kind = operationRecord.kind;
  const idempotencyKey = operationRecord.idempotencyKey;
  if (
    (kind !== 'replace' && kind !== 'restore') ||
    typeof idempotencyKey !== 'string' ||
    idempotencyKey !== row.idempotency_key
  )
    throw new ControlPlaneError('DATABASE_ERROR', 'stored project operation is invalid');
  const label = operationRecord.label;
  const operationValue = {
    kind,
    idempotencyKey,
    ...(typeof label === 'string' ? { label } : {}),
    ...(Number.isSafeInteger(operationRecord.targetRevision)
      ? { targetRevision: operationRecord.targetRevision as number }
      : {}),
  } as ProjectRevisionV1['operation'];
  const document = parseProjectDocument(row.document);
  if (document.projectId !== row.project_id || documentHash(document) !== row.document_hash)
    throw new ControlPlaneError('DATABASE_ERROR', 'stored project document digest is invalid');
  return {
    projectId: row.project_id,
    revision: row.revision,
    baseRevision: row.base_revision,
    idempotencyKey: row.idempotency_key,
    operation: operationValue,
    document,
    documentHash: row.document_hash,
    createdAt: row.created_at.toISOString(),
  };
}

function revisionLabel(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return '';
  const label = (value as Record<string, unknown>).label;
  return typeof label === 'string' ? label : '';
}

function revisionKind(value: unknown): 'replace' | 'restore' | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const kind = (value as Record<string, unknown>).kind;
  return kind === 'replace' || kind === 'restore' ? kind : undefined;
}

function revisionTarget(value: unknown): number | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const target = (value as Record<string, unknown>).targetRevision;
  return Number.isSafeInteger(target) ? (target as number) : undefined;
}
