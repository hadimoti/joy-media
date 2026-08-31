import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { instrumentPostgresPool } from './db-query-observability.js';
import {
  ControlPlaneError,
  SHARED_LIBRARY_OWNER_ID,
  MAX_WORKER_ATTEMPTS,
  assertSupportedWorkerJobType,
  type AssetDeletionResult,
  type AssetLocationRecord,
  type AssetRegistration,
  type Actor,
  type AssetThumbnailReceipt,
  type CloudDerivativeRegistration,
  type ControlPlane,
  type JoyCodeOptInStatus,
  type LocalDerivativeRegistration,
  type MediaAssetRecord,
  type MediaDerivativeRecord,
  type DerivativeKind,
  type Job,
  type JobEvent,
  type LocalGpuWorkerReceipt,
  type MaskWorkerReceipt,
  type RenderExportReceipt,
  type UpscaleWorkerReceipt,
  type WorkerResultReceipt,
  type ProjectMetadata,
  type ProjectLifecycleMetadata,
  type ProjectDuplicateResult,
  type ProjectDeletionResult,
  type WorkerPairingOffer,
  type WorkerRecord,
  type WorkerModelInventoryRecord,
  type WorkerSession,
  validateAssetRegistration,
  validateAssetTags,
  validateCloudDerivativeRegistration,
  validateLocalDerivativeRegistration,
  validateSortName,
  validateWorkerMaxAttempts,
  validateWorkerLeaseDuration,
  validateRenderExportPayload,
  matchesCloudDerivativeRegistration,
  matchesWorkerDerivativeCompletion,
  workerDerivativeId,
} from './control-plane.js';
import { runPostgresMigrations } from './postgres-migrations.js';
import { validateProjectDocumentRecord } from './project-document-store.js';
import { CREATIVE_BRIEF_CONSENT_VERSION } from './creative-brief-runtime-config.js';
import { JOY_CODE_CONSENT_VERSION } from './joy-code-consent.js';

const FIXTURE_THUMBNAIL_SHA256 = '78bf4c43aa7ab3a14c9f1e34f3333f9f612a08191affba3fb9c3e6de88378735';
const FIXTURE_THUMBNAIL_BYTES = 14;
const WORKER_ATTEMPT_BUDGET_EXHAUSTED = 'Worker attempt budget exhausted';

// Project Document Store types for PostgresControlPlane
type PostgresProjectId = string;
type PostgresOwnerId = string;

interface PostgresProjectDocumentRecord {
  readonly projectId: PostgresProjectId;
  readonly ownerId: PostgresOwnerId;
  readonly revisionId: string;
  readonly document: unknown;
}

type PostgresProjectDocumentReadOutcome =
  | { readonly kind: 'ready'; readonly record: PostgresProjectDocumentRecord }
  | {
      readonly kind: 'not-found';
      readonly projectId: PostgresProjectId;
      readonly revisionId: string | null;
    }
  | {
      readonly kind: 'stale-revision';
      readonly projectId: PostgresProjectId;
      readonly requestedRevisionId: string;
      readonly currentRevisionId: string;
    }
  | { readonly kind: 'unavailable'; readonly message: string };

type PostgresProjectDocumentWriteOutcome =
  | {
      readonly kind: 'stored';
      readonly projectId: PostgresProjectId;
      readonly ownerId: PostgresOwnerId;
      readonly revisionId: string;
    }
  | { readonly kind: 'not-found'; readonly projectId: PostgresProjectId }
  | {
      readonly kind: 'owner-denied';
      readonly projectId: PostgresProjectId;
      readonly ownerId: PostgresOwnerId;
      readonly callerId: PostgresOwnerId;
    }
  | {
      readonly kind: 'revision-conflict';
      readonly projectId: PostgresProjectId;
      readonly expectedBaseRevisionId: string;
      readonly actualBaseRevisionId: string;
    }
  | {
      readonly kind: 'invalid-document';
      readonly projectId: PostgresProjectId;
      readonly diagnostics: readonly {
        readonly code: string;
        readonly message: string;
        readonly path: string;
      }[];
    }
  | { readonly kind: 'unavailable'; readonly message: string };

class PostgresProjectDocumentStore {
  constructor(private readonly pool: Pool) {}

  async readDocument(
    callerId: PostgresOwnerId,
    projectId: PostgresProjectId,
    revisionId?: string,
  ): Promise<PostgresProjectDocumentReadOutcome> {
    const projectResult = await this.pool.query<ProjectRow>(
      'SELECT id, owner_id, document_revision_id FROM projects WHERE id = $1',
      [projectId],
    );

    const project = projectResult.rows[0];
    if (project === undefined) {
      return { kind: 'not-found', projectId, revisionId: revisionId ?? null };
    }

    if (project.owner_id !== callerId) {
      return { kind: 'not-found', projectId, revisionId: revisionId ?? null };
    }

    const currentHeadRev = project.document_revision_id;

    if (currentHeadRev === null) {
      return { kind: 'not-found', projectId, revisionId: revisionId ?? null };
    }

    const targetRevision = revisionId ?? currentHeadRev;

    const docResult = await this.pool.query<ProjectDocumentRow>(
      'SELECT schema_version, document FROM project_documents WHERE project_id = $1 AND revision_id = $2',
      [projectId, targetRevision],
    );

    const row = docResult.rows[0];
    if (row === undefined) {
      if (revisionId === undefined) {
        return { kind: 'not-found', projectId, revisionId: null };
      }
      return {
        kind: 'stale-revision',
        projectId,
        requestedRevisionId: revisionId,
        currentRevisionId: currentHeadRev,
      };
    }

    let parsedDocument: unknown;
    try {
      if (typeof row.document === 'string') {
        parsedDocument = JSON.parse(row.document);
      } else {
        parsedDocument = row.document;
      }
    } catch {
      return { kind: 'unavailable', message: 'Project document store is unavailable' };
    }

    const record: PostgresProjectDocumentRecord = {
      projectId,
      ownerId: project.owner_id,
      revisionId: targetRevision,
      document: parsedDocument,
    };

    const diagnostics = validateProjectDocumentRecord(record);
    if (diagnostics.length > 0) {
      return { kind: 'unavailable', message: 'Project document store is unavailable' };
    }

    return {
      kind: 'ready',
      record: {
        projectId,
        ownerId: project.owner_id,
        revisionId: targetRevision,
        document: parsedDocument,
      },
    };
  }

  async listRevisions(
    callerId: PostgresOwnerId,
    projectId: PostgresProjectId,
  ): Promise<readonly string[]> {
    const projectResult = await this.pool.query<ProjectRow>(
      'SELECT id, owner_id FROM projects WHERE id = $1',
      [projectId],
    );

    const project = projectResult.rows[0];
    if (project === undefined) {
      return [];
    }

    if (project.owner_id !== callerId) {
      return [];
    }

    const result = await this.pool.query<ProjectDocumentRow>(
      'SELECT revision_id FROM project_documents WHERE project_id = $1 ORDER BY created_at ASC',
      [projectId],
    );

    return result.rows.map((row) => row.revision_id);
  }

  async writeDocument(
    callerId: PostgresOwnerId,
    record: PostgresProjectDocumentRecord,
    baseRevisionId: string,
  ): Promise<PostgresProjectDocumentWriteOutcome> {
    // 1. Validate the complete record before any database work
    const diagnostics = validateProjectDocumentRecord(record);
    if (diagnostics.length > 0) {
      return {
        kind: 'invalid-document',
        projectId: record.projectId,
        diagnostics: diagnostics.map((d) => ({
          code: d.code,
          message: d.message,
          path: d.path,
        })),
      };
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // 2. Lock and read the project to get current head and enforce ownership
      const projectResult = await client.query<ProjectRow>(
        'SELECT id, owner_id, document_revision_id FROM projects WHERE id = $1 FOR UPDATE',
        [record.projectId],
      );

      const project = projectResult.rows[0];

      // 3. Check if project exists
      if (project === undefined) {
        await client.query('ROLLBACK');
        return { kind: 'not-found', projectId: record.projectId };
      }

      // 4. Check ownership
      if (project.owner_id !== callerId) {
        await client.query('ROLLBACK');
        return {
          kind: 'owner-denied',
          projectId: record.projectId,
          ownerId: project.owner_id,
          callerId,
        };
      }

      // 5. Check that record.ownerId matches the project owner
      if (record.ownerId !== project.owner_id) {
        await client.query('ROLLBACK');
        return {
          kind: 'owner-denied',
          projectId: record.projectId,
          ownerId: project.owner_id,
          callerId,
        };
      }

      // 6. Get current head for CAS check
      const currentHeadRev = project.document_revision_id ?? '';

      // 7. CAS: baseRevisionId must match current head
      if (baseRevisionId !== currentHeadRev) {
        await client.query('ROLLBACK');
        return {
          kind: 'revision-conflict',
          projectId: record.projectId,
          expectedBaseRevisionId: baseRevisionId,
          actualBaseRevisionId: currentHeadRev,
        };
      }

      // 8. Insert the new document revision (immutable)
      try {
        await client.query(
          `INSERT INTO project_documents (project_id, revision_id, schema_version, document, created_at)
           VALUES ($1, $2, $3, $4::jsonb, CURRENT_TIMESTAMP)`,
          [record.projectId, record.revisionId, 1, JSON.stringify(record.document)],
        );
      } catch {
        await client.query('ROLLBACK');
        return { kind: 'unavailable', message: 'Project document store is unavailable' };
      }

      // 9. Atomically update the head pointer
      try {
        await client.query('UPDATE projects SET document_revision_id = $2 WHERE id = $1', [
          record.projectId,
          record.revisionId,
        ]);
      } catch {
        await client.query('ROLLBACK');
        return { kind: 'unavailable', message: 'Project document store is unavailable' };
      }

      await client.query('COMMIT');

      return {
        kind: 'stored',
        projectId: record.projectId,
        ownerId: record.ownerId,
        revisionId: record.revisionId,
      };
    } catch {
      // Any unexpected error - rollback if we have a transaction
      try {
        await client.query('ROLLBACK');
      } catch {
        // Ignore rollback errors
      }
      return { kind: 'unavailable', message: 'Project document store is unavailable' };
    } finally {
      client.release();
    }
  }
}

interface ProjectRow {
  readonly id: string;
  readonly owner_id: string;
  readonly title: string;
  readonly revision: number;
  readonly asset_sync_enabled: boolean;
  readonly trashed_at: Date | null;
  readonly creative_brief_opt_in: boolean;
  readonly creative_brief_consent_version: string | null;
  readonly creative_brief_consent_at: Date | null;
  readonly document_revision_id: string | null;
  readonly joy_code_consent_version: string | null;
}

interface ProjectDocumentRow {
  readonly project_id: string;
  readonly revision_id: string;
  readonly schema_version: number;
  readonly document: unknown;
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
  readonly model_inventory: WorkerModelInventoryRecord | null;
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
  readonly payload: unknown;
  readonly max_attempts: number | null;
  readonly generation: number;
  readonly state: Job['state'];
  readonly lease_owner: string | null;
  readonly lease_expires_at: Date | null;
  readonly lease_token: string | null;
  readonly progress: number;
  readonly cancel_requested: boolean;
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
  readonly result_duration_us: string | number | null;
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

interface EventRow {
  readonly cursor: string | number;
  readonly job_id: string;
  readonly type: string;
  readonly created_at: Date;
}

export interface PostgresControlPlaneOptions {
  /** Test emulators may not implement PostgreSQL's queue-safe SKIP LOCKED. */
  readonly skipLocked?: boolean;
}

/** Durable PostgreSQL implementation of the control-plane contract. */
export class PostgresControlPlane implements ControlPlane {
  readonly #skipLocked: boolean;
  readonly #documentStore: PostgresProjectDocumentStore;
  private readonly pool: Pool;

  constructor(pool: Pool, options: PostgresControlPlaneOptions = {}) {
    this.pool = instrumentPostgresPool(pool);
    this.#skipLocked = options.skipLocked ?? true;
    this.#documentStore = new PostgresProjectDocumentStore(this.pool);
  }

  async initialize(): Promise<void> {
    await runPostgresMigrations(this.pool);
  }

  async createProject(actor: Actor, id: string, title: string): Promise<ProjectMetadata> {
    assertActor(actor);
    try {
      const result = await this.pool.query<ProjectRow>(
        'INSERT INTO projects (id, owner_id, title, revision, asset_sync_enabled) VALUES ($1, $2, $3, 0, true) RETURNING *',
        [id, actor.id, title],
      );
      return projectOf(requiredRow(result.rows[0], 'PROJECT_CREATE_FAILED'));
    } catch (error) {
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

  async getProject(actor: Actor, id: string): Promise<ProjectLifecycleMetadata> {
    const project = await this.projectAllowTrashed(actor, id);
    const result = await this.pool.query<{ readonly count: string }>(
      `SELECT COUNT(*)::text AS count FROM jobs
       WHERE project_id = $1 AND state IN ('queued', 'leased')`,
      [id],
    );
    return { ...project, activeJobCount: Number(result.rows[0]?.count ?? 0) };
  }

  async duplicateProject(
    actor: Actor,
    sourceId: string,
    id: string,
    title: string,
    baseRevision: number,
  ): Promise<ProjectDuplicateResult> {
    return this.transaction(async (client) => {
      const source = await this.project(actor, sourceId, client);
      if (source.revision !== baseRevision)
        throw new ControlPlaneError(
          'REVISION_CONFLICT',
          `expected ${baseRevision}, found ${source.revision}`,
        );
      const sourceAssets = await client.query<MediaAssetRow>(
        'SELECT * FROM media_assets WHERE project_id = $1 ORDER BY id',
        [sourceId],
      );
      if (
        sourceAssets.rows.some((asset) => privateRefsFromLocations(asset.locations).length === 0)
      ) {
        throw new ControlPlaneError('PROJECT_MEDIA_NOT_DURABLE', sourceId);
      }
      let created: ProjectRow;
      try {
        const result = await client.query<ProjectRow>(
          `INSERT INTO projects (id, owner_id, title, revision, asset_sync_enabled, trashed_at)
           VALUES ($1, $2, $3, 0, true, NULL) RETURNING *`,
          [id, actor.id, title],
        );
        created = requiredRow(result.rows[0], 'PROJECT_CREATE_FAILED');
      } catch (error) {
        throw databaseError(error, 'PROJECT_EXISTS', id);
      }
      const assetIdMap: Record<string, string> = {};
      const derivativeIdMap: Record<string, string> = {};
      for (const asset of sourceAssets.rows) {
        const nextId = randomOpaqueId('asset');
        assetIdMap[asset.id] = nextId;
        await client.query(
          `INSERT INTO media_assets
             (id, project_id, kind, display_name, sha256, byte_length, descriptor, locations, created_at, tags, sort_name)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10::jsonb, $11)`,
          [
            nextId,
            id,
            asset.kind,
            asset.display_name,
            asset.sha256,
            asset.byte_length,
            JSON.stringify(asset.descriptor),
            JSON.stringify(
              jsonArray(asset.locations).filter(
                (location) =>
                  location !== null &&
                  typeof location === 'object' &&
                  !Array.isArray(location) &&
                  (location as Record<string, unknown>).kind === 'private-object',
              ),
            ),
            asset.created_at,
            JSON.stringify(asset.tags ?? []),
            asset.sort_name ?? '',
          ],
        );
      }
      const sourceDerivatives = await client.query<MediaDerivativeRow>(
        'SELECT * FROM media_derivatives WHERE project_id = $1 ORDER BY id',
        [sourceId],
      );
      for (const derivative of sourceDerivatives.rows) {
        if (privateRefsFromLocations(derivative.locations).length === 0) continue;
        const nextId = randomOpaqueId('derivative');
        derivativeIdMap[derivative.id] = nextId;
        await client.query(
          `INSERT INTO media_derivatives
             (id, project_id, asset_id, kind, profile, sha256, byte_length, descriptor, availability, locations, verified_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'available-cloud', $9::jsonb, $10)`,
          [
            nextId,
            id,
            assetIdMap[derivative.asset_id] ?? derivative.asset_id,
            derivative.kind,
            derivative.profile,
            derivative.sha256,
            derivative.byte_length,
            JSON.stringify(derivative.descriptor),
            JSON.stringify(
              jsonArray(derivative.locations).filter(
                (location) =>
                  location !== null &&
                  typeof location === 'object' &&
                  !Array.isArray(location) &&
                  (location as Record<string, unknown>).kind === 'private-object',
              ),
            ),
            derivative.verified_at,
          ],
        );
      }
      return { project: projectOf(created), assetIdMap, derivativeIdMap };
    });
  }

  async trashProject(
    actor: Actor,
    id: string,
    baseRevision: number,
    now = Date.now(),
  ): Promise<ProjectMetadata> {
    return this.transaction(async (client) => {
      const current = await this.project(actor, id, client);
      if (current.revision !== baseRevision)
        throw new ControlPlaneError(
          'REVISION_CONFLICT',
          `expected ${baseRevision}, found ${current.revision}`,
        );
      const queued = await client.query<{ readonly id: string }>(
        `UPDATE jobs SET state = 'canceled', cancel_requested = true
         WHERE project_id = $1 AND state = 'queued' RETURNING id`,
        [id],
      );
      for (const job of queued.rows) await this.event(client, job.id, 'canceled', now);
      const leased = await client.query<{ readonly id: string }>(
        `UPDATE jobs SET cancel_requested = true
         WHERE project_id = $1 AND state = 'leased' AND cancel_requested = false RETURNING id`,
        [id],
      );
      for (const job of leased.rows) await this.event(client, job.id, 'cancel-requested', now);
      const result = await client.query<ProjectRow>(
        `UPDATE projects SET trashed_at = $3, revision = revision + 1
         WHERE id = $1 AND owner_id = $2 AND revision = $4 RETURNING *`,
        [id, actor.id, new Date(now), baseRevision],
      );
      return projectOf(requiredRow(result.rows[0], 'PROJECT_TRASH_FAILED'));
    });
  }

  async restoreProject(actor: Actor, id: string, baseRevision: number): Promise<ProjectMetadata> {
    return this.transaction(async (client) => {
      const current = await this.projectAllowTrashed(actor, id, client);
      if (current.trashedAt === undefined) throw new ControlPlaneError('PROJECT_NOT_TRASHED', id);
      if (current.revision !== baseRevision)
        throw new ControlPlaneError(
          'REVISION_CONFLICT',
          `expected ${baseRevision}, found ${current.revision}`,
        );
      const result = await client.query<ProjectRow>(
        `UPDATE projects SET trashed_at = NULL, revision = revision + 1
         WHERE id = $1 AND owner_id = $2 AND revision = $3 AND trashed_at IS NOT NULL RETURNING *`,
        [id, actor.id, baseRevision],
      );
      return projectOf(requiredRow(result.rows[0], 'PROJECT_RESTORE_FAILED'));
    });
  }

  async deleteProject(actor: Actor, id: string): Promise<ProjectDeletionResult> {
    return this.transaction(async (client) => {
      const current = await this.projectAllowTrashed(actor, id, client);
      if (current.trashedAt === undefined) throw new ControlPlaneError('PROJECT_NOT_TRASHED', id);
      const active = await client.query<{ readonly count: string }>(
        `SELECT COUNT(*)::text AS count FROM jobs
         WHERE project_id = $1 AND state IN ('queued', 'leased')`,
        [id],
      );
      if (Number(active.rows[0]?.count ?? 0) > 0) throw new ControlPlaneError('PROJECT_BUSY', id);
      const references = await client.query<{ readonly asset_id: string }>(
        `SELECT asset_id FROM media_asset_access
         WHERE source_project_id = $1
         LIMIT 1`,
        [id],
      );
      if (references.rows[0] !== undefined) throw new ControlPlaneError('PROJECT_REFERENCED', id);
      const associatedQueued = await client.query<{ readonly id: string }>(
        `UPDATE jobs SET state = 'canceled', cancel_requested = true
         WHERE project_id = $1 AND state = 'queued' RETURNING id`,
        [id],
      );
      for (const job of associatedQueued.rows)
        await this.event(client, job.id, 'canceled', Date.now());
      const associatedLeased = await client.query<{ readonly id: string }>(
        `UPDATE jobs SET cancel_requested = true
         WHERE project_id = $1 AND state = 'leased' AND cancel_requested = false RETURNING id`,
        [id],
      );
      for (const job of associatedLeased.rows)
        await this.event(client, job.id, 'cancel-requested', Date.now());
      const assets = await client.query<{ readonly locations: unknown }>(
        'SELECT locations FROM media_assets WHERE project_id = $1',
        [id],
      );
      const derivatives = await client.query<{ readonly locations: unknown }>(
        `SELECT locations FROM media_derivatives
         WHERE project_id = $1`,
        [id],
      );
      const candidates = new Set<string>([
        ...assets.rows.flatMap((row) => privateRefsFromLocations(row.locations)),
        ...derivatives.rows.flatMap((row) => privateRefsFromLocations(row.locations)),
      ]);
      const jobs = await client.query<{ readonly id: string }>(
        'SELECT id FROM jobs WHERE project_id = $1',
        [id],
      );
      const jobIds = jobs.rows.map((job) => job.id);
      if (jobIds.length > 0) {
        await client.query('DELETE FROM job_events WHERE job_id = ANY($1::text[])', [jobIds]);
        await client.query('DELETE FROM job_attempts WHERE job_id = ANY($1::text[])', [jobIds]);
        await client.query('DELETE FROM jobs WHERE project_id = $1', [id]);
      }
      await client.query('DELETE FROM media_derivatives WHERE project_id = $1', [id]);
      await client.query(
        'DELETE FROM media_asset_access WHERE project_id = $1 OR source_project_id = $1',
        [id],
      );
      await client.query('DELETE FROM media_assets WHERE project_id = $1', [id]);
      await client.query('DELETE FROM projects WHERE id = $1 AND owner_id = $2', [id, actor.id]);
      const remainingAssets = await client.query<{ readonly locations: unknown }>(
        'SELECT locations FROM media_assets',
      );
      const remainingDerivatives = await client.query<{ readonly locations: unknown }>(
        'SELECT locations FROM media_derivatives',
      );
      const remaining = new Set<string>([
        ...remainingAssets.rows.flatMap((row) => privateRefsFromLocations(row.locations)),
        ...remainingDerivatives.rows.flatMap((row) => privateRefsFromLocations(row.locations)),
      ]);
      return {
        id,
        orphanedPrivateObjectRefs: [...candidates].filter((ref) => !remaining.has(ref)),
      };
    });
  }

  async setAssetSync(actor: Actor, projectId: string, enabled: boolean): Promise<ProjectMetadata> {
    assertActor(actor);
    if (enabled !== true)
      throw new ControlPlaneError(
        'ASSET_SYNC_REQUIRED',
        'private asset backup is mandatory for JOY Media projects',
      );
    const result = await this.pool.query<ProjectRow>(
      `UPDATE projects SET asset_sync_enabled = true
       WHERE id = $1 AND owner_id = $2 RETURNING *`,
      [projectId, actor.id],
    );
    if (result.rows[0] === undefined) throw new ControlPlaneError('PROJECT_NOT_FOUND', projectId);
    return projectOf(result.rows[0]);
  }

  async getCreativeBriefOptIn(actor: Actor, projectId: string): Promise<boolean> {
    const project = await this.project(actor, projectId);
    return project.creativeBriefOptIn;
  }

  async setCreativeBriefOptIn(
    actor: Actor,
    projectId: string,
    enabled: boolean,
    baseRevision: number,
  ): Promise<ProjectMetadata> {
    assertActor(actor);
    const current = await this.project(actor, projectId);
    if (current.revision !== baseRevision)
      throw new ControlPlaneError(
        'REVISION_CONFLICT',
        `expected ${baseRevision}, found ${current.revision}`,
      );
    const result = await this.pool.query<ProjectRow>(
      `UPDATE projects SET
         creative_brief_opt_in = $3,
         creative_brief_consent_version = $4,
         creative_brief_consent_at = $5,
         revision = revision + 1
       WHERE id = $1 AND owner_id = $2 AND revision = $6 RETURNING *`,
      [
        projectId,
        actor.id,
        enabled,
        enabled ? CREATIVE_BRIEF_CONSENT_VERSION : null,
        enabled ? new Date() : null,
        baseRevision,
      ],
    );
    if (result.rows[0] === undefined) throw new ControlPlaneError('PROJECT_NOT_FOUND', projectId);
    return projectOf(result.rows[0]);
  }

  async getJoyCodeOptIn(actor: Actor, projectId: string): Promise<JoyCodeOptInStatus> {
    assertActor(actor);
    const result = await this.pool.query<{
      readonly revision: number;
      readonly joy_code_consent_version: string | null;
    }>('SELECT revision, joy_code_consent_version FROM projects WHERE id = $1 AND owner_id = $2', [
      projectId,
      actor.id,
    ]);
    const row = result.rows[0];
    if (row === undefined) throw new ControlPlaneError('PROJECT_NOT_FOUND', projectId);
    const consentVersion = row.joy_code_consent_version;
    return {
      enabled: consentVersion === JOY_CODE_CONSENT_VERSION,
      ...(consentVersion === null ? {} : { consentVersion }),
      revision: row.revision,
    };
  }

  async setJoyCodeOptIn(
    actor: Actor,
    projectId: string,
    enabled: boolean,
    consentVersion: string | undefined,
    baseRevision: number,
  ): Promise<ProjectMetadata> {
    assertActor(actor);
    if (enabled && consentVersion !== JOY_CODE_CONSENT_VERSION)
      throw new ControlPlaneError(
        'JOY_CODE_CONSENT_VERSION_REQUIRED',
        'current disclosure version required',
      );
    const result = await this.pool.query<ProjectRow>(
      `UPDATE projects SET joy_code_consent_version = $3, revision = revision + 1
       WHERE id = $1 AND owner_id = $2 AND revision = $4 RETURNING *`,
      [projectId, actor.id, enabled ? JOY_CODE_CONSENT_VERSION : null, baseRevision],
    );
    if (result.rows[0] === undefined) {
      const current = await this.project(actor, projectId);
      if (current.revision !== baseRevision)
        throw new ControlPlaneError(
          'REVISION_CONFLICT',
          `expected ${baseRevision}, found ${current.revision}`,
        );
      throw new ControlPlaneError('PROJECT_NOT_FOUND', projectId);
    }
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
        return mediaAssetOf(requiredRow(result.rows[0], 'ASSET_CREATE_FAILED'));
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
      await this.project(actor, projectId, client);
      const existing = await client.query<MediaAssetRow>(
        'SELECT * FROM media_assets WHERE id = $1 AND project_id = $2',
        [assetId, projectId],
      );
      if (existing.rows[0] === undefined) throw new ControlPlaneError('ASSET_NOT_FOUND', assetId);
      const asset = mediaAssetOf(existing.rows[0]);
      const kept = asset.locations.filter((entry) => entry.kind !== 'private-object');
      const locations = [...kept, { kind: 'private-object' as const, ref: location.ref }];
      if (locations.length === 0 || locations.length > 2)
        throw new ControlPlaneError('ASSET_INVALID', 'one or two opaque locations are required');
      const result = await client.query<MediaAssetRow>(
        `UPDATE media_assets SET locations = $3::jsonb
         WHERE id = $1 AND project_id = $2 RETURNING *`,
        [assetId, projectId, JSON.stringify(locations)],
      );
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
  ): Promise<AssetDeletionResult> {
    return this.transaction(async (client) => {
      await this.project(actor, projectId, client);
      const canonical = await this.lockCanonicalAsset(assetId, client);
      if (canonical === undefined) throw new ControlPlaneError('ASSET_NOT_FOUND', assetId);
      if (canonical.project_id !== projectId) {
        const access = await client.query<{ readonly source_project_id: string }>(
          `SELECT source_project_id
           FROM media_asset_access
           WHERE project_id = $1 AND asset_id = $2 AND source_project_id = $3`,
          [projectId, assetId, canonical.project_id],
        );
        if (
          access.rows[0] === undefined ||
          canonical.source_trashed_at !== null ||
          (canonical.source_owner_id !== actor.id &&
            canonical.source_owner_id !== SHARED_LIBRARY_OWNER_ID)
        ) {
          throw new ControlPlaneError('ASSET_NOT_FOUND', assetId);
        }
        const queuedForAsset = await client.query<{ readonly id: string }>(
          `UPDATE jobs SET state = 'canceled', cancel_requested = true
           WHERE project_id = $1 AND asset_id = $2 AND state = 'queued' RETURNING id`,
          [projectId, assetId],
        );
        for (const job of queuedForAsset.rows)
          await this.event(client, job.id, 'canceled', Date.now());
        const leasedForAsset = await client.query<{ readonly id: string }>(
          `UPDATE jobs SET cancel_requested = true
           WHERE project_id = $1 AND asset_id = $2
             AND state = 'leased' AND cancel_requested = false RETURNING id`,
          [projectId, assetId],
        );
        for (const job of leasedForAsset.rows)
          await this.event(client, job.id, 'cancel-requested', Date.now());
        const derivatives = await client.query<MediaDerivativeRow>(
          'SELECT * FROM media_derivatives WHERE project_id = $1 AND asset_id = $2',
          [projectId, assetId],
        );
        const candidateRefs = new Set(
          derivatives.rows.flatMap((row) => privateRefsFromLocations(row.locations)),
        );
        await client.query(
          'DELETE FROM media_derivatives WHERE project_id = $1 AND asset_id = $2',
          [projectId, assetId],
        );
        await client.query(
          'DELETE FROM media_asset_access WHERE project_id = $1 AND asset_id = $2',
          [projectId, assetId],
        );
        const remainingAssets = await client.query<{ readonly locations: unknown }>(
          'SELECT locations FROM media_assets',
        );
        const remainingDerivatives = await client.query<{ readonly locations: unknown }>(
          'SELECT locations FROM media_derivatives',
        );
        const remainingRefs = new Set([
          ...remainingAssets.rows.flatMap((row) => privateRefsFromLocations(row.locations)),
          ...remainingDerivatives.rows.flatMap((row) => privateRefsFromLocations(row.locations)),
        ]);
        return {
          id: assetId,
          orphanedPrivateObjectRefs: [...candidateRefs].filter((ref) => !remainingRefs.has(ref)),
        };
      }
      const references = await client.query<{ readonly project_id: string }>(
        `SELECT project_id FROM media_asset_access
         WHERE asset_id = $1 AND source_project_id = $2
         LIMIT 1`,
        [assetId, projectId],
      );
      if (references.rows[0] !== undefined)
        throw new ControlPlaneError('ASSET_REFERENCED', assetId);
      const queuedForAsset = await client.query<{ readonly id: string }>(
        `UPDATE jobs SET state = 'canceled', cancel_requested = true
         WHERE project_id = $1 AND asset_id = $2 AND state = 'queued' RETURNING id`,
        [projectId, assetId],
      );
      for (const job of queuedForAsset.rows)
        await this.event(client, job.id, 'canceled', Date.now());
      const leasedForAsset = await client.query<{ readonly id: string }>(
        `UPDATE jobs SET cancel_requested = true
         WHERE project_id = $1 AND asset_id = $2
           AND state = 'leased' AND cancel_requested = false RETURNING id`,
        [projectId, assetId],
      );
      for (const job of leasedForAsset.rows)
        await this.event(client, job.id, 'cancel-requested', Date.now());
      const derivatives = await client.query<MediaDerivativeRow>(
        'SELECT * FROM media_derivatives WHERE project_id = $1 AND asset_id = $2',
        [projectId, assetId],
      );
      const candidateRefs = new Set([
        ...privateRefsFromLocations(canonical.locations),
        ...derivatives.rows.flatMap((row) => privateRefsFromLocations(row.locations)),
      ]);
      await client.query('DELETE FROM media_derivatives WHERE project_id = $1 AND asset_id = $2', [
        projectId,
        assetId,
      ]);
      await client.query(
        'DELETE FROM media_asset_access WHERE source_project_id = $1 AND asset_id = $2',
        [projectId, assetId],
      );
      await client.query('DELETE FROM media_assets WHERE id = $1 AND project_id = $2', [
        assetId,
        projectId,
      ]);
      const remainingAssets = await client.query<{ readonly locations: unknown }>(
        'SELECT locations FROM media_assets',
      );
      const remainingDerivatives = await client.query<{ readonly locations: unknown }>(
        'SELECT locations FROM media_derivatives',
      );
      const remainingRefs = new Set(
        [...remainingAssets.rows, ...remainingDerivatives.rows].flatMap((row) =>
          privateRefsFromLocations(row.locations),
        ),
      );
      return {
        id: assetId,
        orphanedPrivateObjectRefs: [...candidateRefs].filter((ref) => !remainingRefs.has(ref)),
      };
    });
  }

  async assetsForProject(actor: Actor, projectId: string): Promise<readonly MediaAssetRecord[]> {
    await this.project(actor, projectId);
    const result = await this.pool.query<MediaAssetRow>(
      `SELECT * FROM (
         SELECT a.* FROM media_assets a WHERE a.project_id = $1
         UNION ALL
         SELECT a.id, $1 AS project_id, a.kind, a.display_name, a.sha256, a.byte_length,
                a.descriptor, a.locations, a.created_at, a.tags, a.sort_name
         FROM media_asset_access asset_access
         JOIN media_assets a ON a.id = asset_access.asset_id AND a.project_id = asset_access.source_project_id
         JOIN projects source ON source.id = asset_access.source_project_id
         WHERE asset_access.project_id = $1 AND source.owner_id IN ($2, $3)
           AND source.trashed_at IS NULL
       ) AS assets
       ORDER BY COALESCE(CASE WHEN assets.sort_name = '' THEN NULL ELSE assets.sort_name END,
                         lower(assets.display_name)), assets.id`,
      [projectId, actor.id, SHARED_LIBRARY_OWNER_ID],
    );
    return result.rows.map(mediaAssetOf);
  }

  async associateAsset(
    actor: Actor,
    projectId: string,
    assetId: string,
  ): Promise<MediaAssetRecord> {
    return this.transaction(async (client) => {
      await this.project(actor, projectId, client);
      const row = await this.lockCanonicalAsset(assetId, client);
      if (row !== undefined && row.project_id === projectId) return mediaAssetOf(row);
      if (
        row === undefined ||
        row.source_trashed_at !== null ||
        (row.source_owner_id !== actor.id && row.source_owner_id !== SHARED_LIBRARY_OWNER_ID) ||
        privateRefsFromLocations(row.locations).length === 0
      )
        throw new ControlPlaneError('ASSET_NOT_FOUND', assetId);
      await client.query(
        `INSERT INTO media_asset_access (project_id, asset_id, source_project_id, created_at)
         VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
         ON CONFLICT (project_id, asset_id) DO UPDATE SET source_project_id = EXCLUDED.source_project_id`,
        [projectId, assetId, row.project_id],
      );
      return mediaAssetOf({ ...row, project_id: projectId });
    });
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
       WHERE p.owner_id = $1
       ORDER BY COALESCE(CASE WHEN a.sort_name = '' THEN NULL ELSE a.sort_name END, lower(a.display_name)), a.id`,
      [SHARED_LIBRARY_OWNER_ID],
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
         AND (p.owner_id = $2 OR p.owner_id = $3)`,
      [assetId, actor.id, SHARED_LIBRARY_OWNER_ID],
    );
    const row = result.rows[0];
    if (row === undefined) throw new ControlPlaneError('ASSET_NOT_FOUND', assetId);
    const asset = mediaAssetOf(row);
    if (!asset.locations.some((location) => location.kind === 'private-object'))
      throw new ControlPlaneError('ASSET_NOT_FOUND', assetId);
    return asset;
  }

  async workerJobAsset(
    workerId: string,
    jobId: string,
    now = Date.now(),
    leaseToken?: string,
  ): Promise<MediaAssetRecord> {
    const result = await this.pool.query<MediaAssetRow>(
      `SELECT a.* FROM jobs
       JOIN workers ON workers.id = jobs.lease_owner
       JOIN media_assets a ON a.id = jobs.asset_id AND a.project_id = jobs.project_id
       WHERE jobs.id = $1 AND jobs.state = 'leased' AND jobs.lease_owner = $2
         AND jobs.lease_expires_at > $3 AND jobs.lease_token = $4
         AND workers.revoked_at IS NULL`,
      [jobId, workerId, new Date(now), leaseToken ?? ''],
    );
    const row = result.rows[0];
    if (row === undefined) throw new ControlPlaneError('ASSET_NOT_FOUND', jobId);
    const asset = mediaAssetOf(row);
    if (!asset.locations.some((location) => location.kind === 'private-object'))
      throw new ControlPlaneError('ASSET_NOT_FOUND', asset.id);
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
      try {
        const result = await client.query<MediaDerivativeRow>(
          `INSERT INTO media_derivatives
             (id, project_id, asset_id, kind, profile, sha256, byte_length, descriptor, availability, locations, verified_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb, $11)
           ${cloud ? 'ON CONFLICT (id) DO NOTHING' : ''}
           RETURNING *`,
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
        if (result.rows[0] !== undefined) {
          const stored = mediaDerivativeOf(result.rows[0]);
          if (
            !cloud ||
            matchesCloudDerivativeRegistration(
              stored,
              projectId,
              derivative as CloudDerivativeRegistration,
            )
          )
            return stored;
          // pg-mem returns the conflicting row for DO NOTHING whereas real
          // PostgreSQL returns no row. Enforce the same exact-match contract.
          throw new ControlPlaneError('DERIVATIVE_EXISTS', derivative.id);
        }
        if (cloud) {
          const found = await client.query<MediaDerivativeRow>(
            'SELECT * FROM media_derivatives WHERE id = $1',
            [derivative.id],
          );
          const existing =
            found.rows[0] === undefined ? undefined : mediaDerivativeOf(found.rows[0]);
          if (
            existing !== undefined &&
            matchesCloudDerivativeRegistration(
              existing,
              projectId,
              derivative as CloudDerivativeRegistration,
            )
          )
            return existing;
          throw new ControlPlaneError('DERIVATIVE_EXISTS', derivative.id);
        }
        throw new ControlPlaneError('DERIVATIVE_CREATE_FAILED', derivative.id);
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
    leaseToken?: string,
  ): Promise<MediaDerivativeRecord> {
    const result = await this.pool.query<{
      readonly project_id: string;
      readonly asset_id: string | null;
      readonly type: string;
      readonly generation: number;
      readonly owner_id: string;
      readonly asset_sync_enabled: boolean;
    }>(
      `SELECT jobs.project_id, jobs.asset_id, jobs.type, jobs.generation, workers.owner_id, projects.asset_sync_enabled
       FROM jobs JOIN workers ON workers.id = jobs.lease_owner
       JOIN projects ON projects.id = jobs.project_id
       WHERE jobs.id = $1 AND jobs.state = 'leased' AND jobs.lease_owner = $2
         AND jobs.lease_expires_at > $3 AND jobs.lease_token = $4 AND workers.revoked_at IS NULL`,
      [jobId, workerId, new Date(now), leaseToken ?? ''],
    );
    const job = result.rows[0];
    const canonicalDerivative =
      job === undefined
        ? derivative
        : { ...derivative, id: workerDerivativeId(jobId, job.generation) };
    if (
      job === undefined ||
      job.asset_id !== canonicalDerivative.assetId ||
      derivativeKindForJob(job.type) !== canonicalDerivative.kind ||
      !job.asset_sync_enabled
    )
      throw new ControlPlaneError('DERIVATIVE_UPLOAD_DENIED', jobId);
    validateCloudDerivativeRegistration(canonicalDerivative);
    return this.registerDerivative(
      { id: job.owner_id },
      job.project_id,
      canonicalDerivative,
      now,
      true,
    );
  }

  async workerCloudDerivativeForCompletion(
    workerId: string,
    jobId: string,
    receipt: WorkerResultReceipt,
    now = Date.now(),
    leaseToken?: string,
  ): Promise<MediaDerivativeRecord> {
    const jobResult = await this.pool.query<JobRow>(
      `SELECT jobs.* FROM jobs
       JOIN workers ON workers.id = jobs.lease_owner
       WHERE jobs.id = $1 AND jobs.state = 'leased' AND jobs.lease_owner = $2
         AND jobs.lease_expires_at > $3 AND jobs.lease_token = $4
         AND workers.revoked_at IS NULL`,
      [jobId, workerId, new Date(now), leaseToken ?? ''],
    );
    const jobRow = jobResult.rows[0];
    if (jobRow === undefined) throw new ControlPlaneError('LEASE_NOT_OWNED', jobId);
    const job = jobOf(jobRow);
    const derivativeResult = await this.pool.query<MediaDerivativeRow>(
      'SELECT * FROM media_derivatives WHERE id = $1 AND project_id = $2 AND asset_id = $3',
      [workerDerivativeId(job.id, job.generation), job.projectId, job.assetId ?? ''],
    );
    const row = derivativeResult.rows[0];
    if (
      row === undefined ||
      !matchesWorkerDerivativeCompletion(mediaDerivativeOf(row), job, receipt)
    )
      throw new ControlPlaneError('DERIVATIVE_NOT_READY', jobId);
    return mediaDerivativeOf(row);
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
    modelInventory?: WorkerModelInventoryRecord,
  ): Promise<WorkerRecord> {
    const assets = normalizeOpaqueAssetIds(localAssetIds);
    const result = await this.pool.query<WorkerRow>(
      `UPDATE workers SET capabilities = $2::jsonb, local_asset_ids = $3::jsonb, last_seen_at = $4, model_inventory = $5::jsonb
       WHERE id = $1 AND revoked_at IS NULL RETURNING *`,
      [
        workerId,
        JSON.stringify([...new Set(capabilities)].sort()),
        JSON.stringify(assets),
        new Date(now),
        modelInventory === undefined ? null : JSON.stringify(modelInventory),
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
    payload?: Readonly<Record<string, unknown>>,
    maxAttempts?: number,
  ): Promise<Job> {
    assertSupportedWorkerJobType(type);
    if (type === 'asset.thumbnail')
      throw new ControlPlaneError(
        'ASSET_JOB_INVALID',
        'asset thumbnail requires an opaque asset ID',
      );
    return this.transaction(async (client) => {
      await this.project(actor, projectId, client);
      validateWorkerMaxAttempts(maxAttempts);
      if (requiresSourceAsset(type) && assetId === undefined)
        throw new ControlPlaneError('ASSET_JOB_INVALID', 'Worker generation requires an asset ID');
      if (requiresSourceAsset(type) && assetId !== undefined) {
        await this.asset(actor, projectId, assetId, client);
        if (type === 'mask.image' || type === 'mask.video') {
          const source = await client.query<{ readonly kind: MediaAssetRecord['kind'] }>(
            `SELECT kind FROM media_assets WHERE id = $1 AND project_id = $2
             UNION ALL
             SELECT a.kind FROM media_asset_access asset_access
             JOIN media_assets a ON a.id = asset_access.asset_id
               AND a.project_id = asset_access.source_project_id
             JOIN projects source ON source.id = asset_access.source_project_id
             WHERE asset_access.asset_id = $1 AND asset_access.project_id = $2
               AND source.owner_id IN ($3, $4) AND source.trashed_at IS NULL`,
            [assetId, projectId, actor.id, SHARED_LIBRARY_OWNER_ID],
          );
          const kind = requiredRow(source.rows[0], 'ASSET_NOT_FOUND').kind;
          if (
            (type === 'mask.image' && kind !== 'image') ||
            (type === 'mask.video' && kind !== 'video')
          )
            throw new ControlPlaneError('ASSET_JOB_INVALID', `${type} source kind is invalid`);
        }
      }
      const safePayload = validatedJobPayload(payload ?? {});
      if (type === 'render.export') validateRenderExportPayload(projectId, safePayload);
      try {
        const result = await client.query<JobRow>(
          `INSERT INTO jobs
             (id, project_id, type, asset_id, payload, max_attempts, generation, state, lease_owner, lease_expires_at, lease_token)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, 0, 'queued', NULL, NULL, NULL) RETURNING *`,
          [id, projectId, type, assetId ?? null, JSON.stringify(safePayload), maxAttempts ?? null],
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
    maxAttempts?: number,
  ): Promise<Job> {
    return this.transaction(async (client) => {
      await this.asset(actor, projectId, assetId, client);
      validateWorkerMaxAttempts(maxAttempts);
      try {
        const result = await client.query<JobRow>(
          `INSERT INTO jobs
             (id, project_id, type, asset_id, max_attempts, generation, state, lease_owner, lease_expires_at, lease_token)
           VALUES ($1, $2, 'asset.thumbnail', $3, $4, 0, 'queued', NULL, NULL, NULL) RETURNING *`,
          [id, projectId, assetId, maxAttempts ?? null],
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
    validateWorkerLeaseDuration(durationMs);
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
         WHERE (state = 'queued' OR (state = 'leased' AND lease_expires_at <= $1))
         ORDER BY id LIMIT 64 FOR UPDATE${this.#skipLocked ? ' SKIP LOCKED' : ''}`,
        [new Date(now)],
      );
      // Keep opaque-locality matching in the Worker/control-plane domain; this
      // also keeps the durable contract executable in pg-mem without changing
      // PostgreSQL's queue lock semantics.
      const compatibleJobs = candidate.rows.filter((item) => {
        const caps = workerRecord.capabilities;
        if (item.type === 'asset.thumbnail') {
          return (
            item.asset_id !== null &&
            caps.includes('asset.thumbnail') &&
            workerRecord.localAssetIds.includes(item.asset_id)
          );
        }
        if (item.type === 'image.comfy') return caps.includes('image.comfy');
        if (item.type === 'audio.ml-denoise') return caps.includes('audio.ml-denoise');
        if (item.type === 'mask.image' || item.type === 'mask.video') {
          return (
            item.asset_id !== null &&
            caps.includes(item.type) &&
            workerRecord.localAssetIds.includes(item.asset_id)
          );
        }
        if (item.type === 'upscale.image' || item.type === 'upscale.video') {
          return (
            item.asset_id !== null &&
            caps.includes(item.type) &&
            workerRecord.localAssetIds.includes(item.asset_id)
          );
        }
        return true;
      });
      let job: JobRow | undefined;
      for (const item of compatibleJobs) {
        if (item.state === 'leased') {
          await client.query(
            `UPDATE job_attempts SET completed_at = $2
             WHERE job_id = $1 AND generation = $3 AND completed_at IS NULL`,
            [item.id, new Date(now), item.generation],
          );
        }
        if (item.max_attempts !== null) {
          const attempts = await client.query<{ readonly count: string }>(
            'SELECT COUNT(*)::text AS count FROM job_attempts WHERE job_id = $1 AND generation = $2',
            [item.id, item.generation],
          );
          const count = Number(attempts.rows[0]?.count ?? 0);
          if (count >= item.max_attempts) {
            const terminalState = item.cancel_requested ? 'canceled' : 'failed';
            await client.query(
              `UPDATE jobs SET state = $2, lease_owner = NULL, lease_expires_at = NULL, lease_token = NULL,
                   cancel_requested = false, error = $3
               WHERE id = $1`,
              [
                item.id,
                terminalState,
                terminalState === 'failed' ? WORKER_ATTEMPT_BUDGET_EXHAUSTED : null,
              ],
            );
            await this.event(client, item.id, terminalState, now);
            continue;
          }
        }
        job = item;
        break;
      }
      if (job === undefined) return undefined;
      const leaseToken = randomUUID();
      const result = await client.query<JobRow>(
        `UPDATE jobs SET state = 'leased', lease_owner = $2, lease_expires_at = $3, lease_token = $4,
             cancel_requested = false
         WHERE id = $1 RETURNING *`,
        [job.id, workerId, new Date(now + durationMs), leaseToken],
      );
      await client.query(
        'INSERT INTO job_attempts (job_id, generation, worker_id, started_at) VALUES ($1, $2, $3, $4)',
        [job.id, job.generation, workerId, new Date(now)],
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
    leaseToken?: string,
  ): Promise<{ readonly job: Job; readonly cancelRequested: boolean }> {
    validateWorkerLeaseDuration(durationMs);
    if (!Number.isSafeInteger(progress) || progress < 0 || progress > 100)
      throw new ControlPlaneError('PROGRESS_INVALID', jobId);
    return this.transaction(async (client) => {
      const result = await client.query<JobRow>(
        `UPDATE jobs SET progress = $3, lease_expires_at = $4
         WHERE id = $1 AND state = 'leased' AND lease_owner = $2 AND lease_expires_at > $5
           AND progress <= $3 AND lease_token = $6
         RETURNING *`,
        [jobId, workerId, progress, new Date(now + durationMs), new Date(now), leaseToken ?? ''],
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
    leaseToken?: string,
  ): Promise<Job> {
    const isThumb = receipt?.kind === 'asset.thumbnail';
    const isExport = receipt?.kind === 'render.export';
    const isGpu = receipt?.kind === 'image.comfy' || receipt?.kind === 'audio.ml-denoise';
    const isMask = receipt?.kind === 'mask.image' || receipt?.kind === 'mask.video';
    const isUpscale = receipt?.kind === 'upscale.image' || receipt?.kind === 'upscale.video';
    const storesAsset = isThumb || isExport || isGpu || isMask || isUpscale;
    return this.transaction(async (client) => {
      // Lock the leased row while checking its generation's durable cloud
      // derivative.  The completion update below is intentionally not allowed
      // to race a retry/re-lease or to project a receipt that was never stored.
      const leasedResult = await client.query<JobRow>(
        `SELECT * FROM jobs
         WHERE id = $1 AND state = 'leased' AND lease_owner = $2
           AND lease_expires_at > $3 AND lease_token = $4
         FOR UPDATE`,
        [jobId, workerId, new Date(now), leaseToken ?? ''],
      );
      const leasedRow = leasedResult.rows[0];
      if (leasedRow === undefined) throw new ControlPlaneError('LEASE_NOT_OWNED', jobId);
      const leasedJob = jobOf(leasedRow);
      // Cancellation is a terminal intent for this lease. A late provider
      // result must not overwrite it with a successful completion.
      if (leasedJob.cancelRequested) throw new ControlPlaneError('JOB_CANCEL_REQUESTED', jobId);
      if (receipt !== undefined && !isWorkerReceipt(receipt))
        throw new ControlPlaneError('RESULT_INVALID', jobId);
      if (derivativeKindForJob(leasedJob.type) !== undefined) {
        const expectedId = workerDerivativeId(leasedJob.id, leasedJob.generation);
        const derivativeResult = await client.query<MediaDerivativeRow>(
          'SELECT * FROM media_derivatives WHERE id = $1 AND project_id = $2 AND asset_id = $3',
          [expectedId, leasedJob.projectId, leasedJob.assetId ?? ''],
        );
        const stored = derivativeResult.rows[0];
        if (
          stored === undefined ||
          receipt === undefined ||
          !matchesWorkerDerivativeCompletion(mediaDerivativeOf(stored), leasedJob, receipt)
        )
          throw new ControlPlaneError('DERIVATIVE_NOT_READY', jobId);
      }
      const result = await client.query<JobRow>(
        `UPDATE jobs SET state = 'completed', progress = 100, cancel_requested = false,
             result_kind = $4, result_sha256 = $5, result_bytes = $6,
             result_ref = $7, result_worker_ref = $8, result_verified_at = $9,
             result_asset_id = $10, result_local_ref = $11, result_mime_type = $12,
             result_width = $13, result_height = $14, result_duration_us = $15
         WHERE id = $1 AND state = 'leased' AND lease_owner = $2 AND lease_expires_at > $3
           AND cancel_requested = false
           AND (type <> 'fixture.thumbnail' OR $4 = 'fixture.thumbnail')
           AND (type <> 'asset.thumbnail' OR ($4 = 'asset.thumbnail' AND asset_id = $10))
           AND (type <> 'image.comfy' OR ($4 = 'image.comfy' AND asset_id = $10))
           AND (type <> 'audio.ml-denoise' OR ($4 = 'audio.ml-denoise' AND asset_id = $10))
            AND (type <> 'mask.image' OR ($4 = 'mask.image' AND asset_id = $10))
            AND (type <> 'mask.video' OR ($4 = 'mask.video' AND asset_id = $10))
            AND (type <> 'upscale.image' OR ($4 = 'upscale.image' AND asset_id = $10))
           AND (type <> 'upscale.video' OR ($4 = 'upscale.video' AND asset_id = $10))
           AND lease_token = $16
         RETURNING *`,
        [
          jobId,
          workerId,
          new Date(now),
          receipt?.kind ?? null,
          receipt?.sha256 ?? null,
          receipt?.bytes ?? null,
          receipt === undefined
            ? null
            : receipt?.kind === 'fixture.thumbnail'
              ? `derivative:${jobId}`
              : `derivative:${workerDerivativeId(leasedJob.id, leasedJob.generation).slice('derivative-'.length)}`,
          receipt === undefined ? null : workerId,
          receipt === undefined ? null : new Date(now),
          storesAsset && receipt !== undefined ? receipt.assetId : null,
          storesAsset && receipt !== undefined ? receipt.localRef : null,
          storesAsset && receipt !== undefined ? receipt.descriptor.mimeType : null,
          isThumb && receipt?.kind === 'asset.thumbnail'
            ? receipt.descriptor.width
            : (isExport || isGpu || isMask || isUpscale) && receipt !== undefined
              ? (receipt.descriptor.width ?? null)
              : null,
          isThumb && receipt?.kind === 'asset.thumbnail'
            ? receipt.descriptor.height
            : (isExport || isGpu || isMask || isUpscale) && receipt !== undefined
              ? (receipt.descriptor.height ?? null)
              : null,
          (isExport || isGpu || isMask || isUpscale) && receipt !== undefined
            ? (receipt.descriptor.durationUs ?? null)
            : null,
          leaseToken ?? '',
        ],
      );
      if (result.rows[0] === undefined) throw new ControlPlaneError('LEASE_NOT_OWNED', jobId);
      await client.query(
        `UPDATE job_attempts SET completed_at = $3
         WHERE id = (SELECT id FROM job_attempts WHERE job_id = $1 AND worker_id = $2
                     AND generation = (SELECT generation FROM jobs WHERE id = $1)
                     AND completed_at IS NULL
                     ORDER BY id DESC LIMIT 1)`,
        [jobId, workerId, new Date(now)],
      );
      await this.event(client, jobId, 'completed', now);
      return jobOf(result.rows[0]);
    });
  }

  async fail(
    workerId: string,
    jobId: string,
    error: string,
    now = Date.now(),
    leaseToken?: string,
  ): Promise<Job> {
    return this.transaction(async (client) => {
      const result = await client.query<JobRow>(
        `UPDATE jobs SET state = CASE WHEN $4 = 'canceled' THEN 'canceled' ELSE 'failed' END,
             cancel_requested = false, error = CASE WHEN $4 = 'canceled' THEN NULL ELSE $4 END
         WHERE id = $1 AND state = 'leased' AND lease_owner = $2 AND lease_expires_at > $3
           AND lease_token = $5
         RETURNING *`,
        [jobId, workerId, new Date(now), error.slice(0, 500), leaseToken ?? ''],
      );
      if (result.rows[0] === undefined) throw new ControlPlaneError('LEASE_NOT_OWNED', jobId);
      await client.query(
        `UPDATE job_attempts SET completed_at = $3
         WHERE id = (SELECT id FROM job_attempts WHERE job_id = $1 AND worker_id = $2
                     AND generation = (SELECT generation FROM jobs WHERE id = $1)
                     AND completed_at IS NULL
                     ORDER BY id DESC LIMIT 1)`,
        [jobId, workerId, new Date(now)],
      );
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
      const currentResult = await client.query<JobRow>(
        'SELECT * FROM jobs WHERE id = $1 AND project_id = $2 FOR UPDATE',
        [jobId, projectId],
      );
      const current = currentResult.rows[0];
      if (current === undefined || !['completed', 'canceled', 'failed'].includes(current.state))
        throw new ControlPlaneError('JOB_NOT_RETRYABLE', jobId);
      // Manual retry starts a new generation; historical attempts remain
      // intact for audit and the configured budget applies per generation.
      const result = await client.query<JobRow>(
        `UPDATE jobs SET state = 'queued', generation = generation + 1, progress = 0, cancel_requested = false,
             lease_owner = NULL, lease_expires_at = NULL, result_kind = NULL,
             result_sha256 = NULL, result_bytes = NULL, result_ref = NULL,
             result_worker_ref = NULL, result_verified_at = NULL, result_asset_id = NULL,
             result_local_ref = NULL, result_mime_type = NULL, result_width = NULL,
             result_height = NULL, result_duration_us = NULL, error = NULL, lease_token = NULL
         WHERE id = $1 AND project_id = $2 AND state IN ('completed', 'canceled', 'failed')
         RETURNING *`,
        [jobId, projectId],
      );
      await this.event(client, jobId, 'retried', now);
      return jobOf(requiredRow(result.rows[0], 'JOB_RETRY_FAILED'));
    });
  }

  async jobsForProject(actor: Actor, projectId: string): Promise<readonly Job[]> {
    await this.projectAllowTrashed(actor, projectId);
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
    await this.projectAllowTrashed(actor, projectId);
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
  async readProjectDocument(
    actor: Actor,
    projectId: string,
    revisionId?: string,
  ): Promise<PostgresProjectDocumentReadOutcome> {
    return this.#documentStore.readDocument(actor.id, projectId, revisionId);
  }

  async listProjectRevisions(actor: Actor, projectId: string): Promise<readonly string[]> {
    return this.#documentStore.listRevisions(actor.id, projectId);
  }

  async writeProjectDocument(
    actor: Actor,
    record: PostgresProjectDocumentRecord,
    baseRevisionId: string,
  ): Promise<PostgresProjectDocumentWriteOutcome> {
    return this.#documentStore.writeDocument(actor.id, record, baseRevisionId);
  }

  private async project(
    actor: Actor,
    id: string,
    client: Pool | PoolClient = this.pool,
  ): Promise<ProjectMetadata> {
    const project = await this.projectAllowTrashed(actor, id, client);
    if (project.trashedAt !== undefined) throw new ControlPlaneError('PROJECT_TRASHED', id);
    return project;
  }

  private async projectAllowTrashed(
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
      `SELECT id FROM media_assets WHERE id = $1 AND project_id = $2
       UNION ALL
       SELECT a.id FROM media_asset_access asset_access
       JOIN media_assets a ON a.id = asset_access.asset_id AND a.project_id = asset_access.source_project_id
       JOIN projects source ON source.id = asset_access.source_project_id
       WHERE asset_access.asset_id = $1 AND asset_access.project_id = $2
         AND source.owner_id IN ($3, $4) AND source.trashed_at IS NULL`,
      [assetId, projectId, actor.id, SHARED_LIBRARY_OWNER_ID],
    );
    if (result.rows[0] === undefined) throw new ControlPlaneError('ASSET_NOT_FOUND', assetId);
  }

  private async lockCanonicalAsset(
    assetId: string,
    client: Pool | PoolClient,
  ): Promise<
    | (MediaAssetRow & {
        readonly source_owner_id: string;
        readonly source_trashed_at: Date | null;
      })
    | undefined
  > {
    const result = await client.query<
      MediaAssetRow & {
        readonly source_owner_id: string;
        readonly source_trashed_at: Date | null;
      }
    >(
      `SELECT a.*, p.owner_id AS source_owner_id, p.trashed_at AS source_trashed_at
       FROM media_assets a
       JOIN projects p ON p.id = a.project_id
       WHERE a.id = $1
       FOR UPDATE`,
      [assetId],
    );
    return result.rows[0];
  }

  private async event(client: PoolClient, jobId: string, type: string, at: number): Promise<void> {
    await client.query('INSERT INTO job_events (job_id, type, created_at) VALUES ($1, $2, $3)', [
      jobId,
      type,
      new Date(at),
    ]);
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
    creativeBriefOptIn:
      row.creative_brief_opt_in &&
      row.creative_brief_consent_version === CREATIVE_BRIEF_CONSENT_VERSION,
    ...(row.trashed_at === null ? {} : { trashedAt: row.trashed_at.getTime() }),
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
    ...(row.model_inventory === null ? {} : { modelInventory: row.model_inventory }),
  };
}

function jobOf(row: JobRow): Job {
  if (
    row.max_attempts !== null &&
    (!Number.isSafeInteger(row.max_attempts) ||
      row.max_attempts < 1 ||
      row.max_attempts > MAX_WORKER_ATTEMPTS)
  )
    throw new ControlPlaneError('DATABASE_ERROR', 'stored job max_attempts is invalid');
  const payload = jobPayloadOf(row.payload);
  return {
    id: row.id,
    projectId: row.project_id,
    type: row.type,
    ...(row.asset_id === null ? {} : { assetId: row.asset_id }),
    ...(Object.keys(payload).length === 0 ? {} : { payload }),
    ...(row.max_attempts === null ? {} : { maxAttempts: row.max_attempts }),
    generation: row.generation,
    state: row.state,
    progress: row.progress,
    cancelRequested: row.cancel_requested,
    ...(row.lease_owner === null ? {} : { leaseOwner: row.lease_owner }),
    ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: row.lease_expires_at.getTime() }),
    ...(row.lease_token === null ? {} : { leaseToken: row.lease_token }),
    ...(row.result_kind === null ||
    row.result_sha256 === null ||
    row.result_bytes === null ||
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

function jobPayloadOf(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value === 'string') {
    try {
      return jsonObject(JSON.parse(value));
    } catch {
      throw new ControlPlaneError('DATABASE_ERROR', 'stored job payload is invalid');
    }
  }
  return jsonObject(value);
}

function derivativeOfRow(row: JobRow): NonNullable<Job['derivative']> {
  const base = {
    id: workerDerivativeId(row.id, row.generation),
    jobId: row.id,
    sha256: row.result_sha256!,
    bytes: row.result_bytes!,
    resultRef: row.result_ref!,
    workerRef: row.result_worker_ref!,
    verifiedAt: row.result_verified_at!.getTime(),
  };
  if (row.result_kind === 'fixture.thumbnail') return { ...base, kind: row.result_kind };
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
      kind: row.result_kind,
      assetId: row.result_asset_id,
      localRef: row.result_local_ref,
      descriptor: { mimeType: 'image/jpeg', width: row.result_width, height: row.result_height },
    };
  }
  if (
    row.result_kind === 'render.export' &&
    row.result_asset_id !== null &&
    row.result_local_ref !== null &&
    row.result_mime_type === 'video/mp4' &&
    row.result_width !== null &&
    row.result_height !== null &&
    row.result_duration_us !== null
  ) {
    return {
      ...base,
      kind: row.result_kind,
      assetId: row.result_asset_id,
      localRef: row.result_local_ref,
      descriptor: {
        mimeType: 'video/mp4',
        width: safeNonNegativeInteger(row.result_width, 'result width'),
        height: safeNonNegativeInteger(row.result_height, 'result height'),
        durationUs: safeNonNegativeInteger(row.result_duration_us, 'result duration'),
      },
    };
  }
  if (
    (row.result_kind === 'image.comfy' ||
      row.result_kind === 'audio.ml-denoise' ||
      row.result_kind === 'mask.image' ||
      row.result_kind === 'mask.video' ||
      row.result_kind === 'upscale.image' ||
      row.result_kind === 'upscale.video') &&
    row.result_asset_id !== null &&
    row.result_local_ref !== null &&
    row.result_mime_type !== null
  ) {
    return {
      ...base,
      kind: row.result_kind,
      assetId: row.result_asset_id,
      localRef: row.result_local_ref,
      descriptor: {
        mimeType: row.result_mime_type,
        ...(row.result_width === null ? {} : { width: row.result_width }),
        ...(row.result_height === null ? {} : { height: row.result_height }),
        ...(row.result_duration_us === null
          ? {}
          : { durationUs: safeNonNegativeInteger(row.result_duration_us, 'result duration') }),
      },
    };
  }
  throw new ControlPlaneError('DATABASE_ERROR', 'stored Worker result is invalid');
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

function privateRefsFromLocations(value: unknown): string[] {
  return jsonArray(value).flatMap((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const location = entry as Record<string, unknown>;
    return location.kind === 'private-object' && typeof location.ref === 'string'
      ? [location.ref]
      : [];
  });
}

function randomOpaqueId(prefix: string): string {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  return `${prefix}-${random}`;
}

function isFixtureReceipt(
  value: WorkerResultReceipt,
): value is WorkerResultReceipt & { readonly kind: 'fixture.thumbnail' } {
  return (
    value.kind === 'fixture.thumbnail' &&
    value.sha256 === FIXTURE_THUMBNAIL_SHA256 &&
    value.bytes === FIXTURE_THUMBNAIL_BYTES
  );
}

function isWorkerReceipt(value: WorkerResultReceipt): boolean {
  return (
    isFixtureReceipt(value) ||
    isAssetThumbnailReceipt(value) ||
    isRenderExportReceipt(value) ||
    isLocalGpuReceipt(value) ||
    isMaskReceipt(value) ||
    isUpscaleReceipt(value)
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

function isRenderExportReceipt(value: WorkerResultReceipt): value is RenderExportReceipt {
  const descriptor =
    value.kind === 'render.export' &&
    typeof value.descriptor === 'object' &&
    value.descriptor !== null &&
    !Array.isArray(value.descriptor)
      ? value.descriptor
      : undefined;
  return (
    value.kind === 'render.export' &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.assetId) &&
    /^[a-f0-9]{64}$/.test(value.sha256) &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes > 0 &&
    /^export-[A-Za-z0-9._-]{1,120}$/.test(value.localRef) &&
    descriptor?.mimeType === 'video/mp4' &&
    Number.isSafeInteger(descriptor.width) &&
    (descriptor.width ?? 0) > 0 &&
    Number.isSafeInteger(descriptor.height) &&
    (descriptor.height ?? 0) > 0 &&
    Number.isSafeInteger(descriptor.durationUs) &&
    (descriptor.durationUs ?? 0) > 0
  );
}

function isMaskReceipt(value: WorkerResultReceipt): value is MaskWorkerReceipt {
  const image = value.kind === 'mask.image';
  const video = value.kind === 'mask.video';
  return (
    (image || video) &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.assetId) &&
    /^[a-f0-9]{64}$/.test(value.sha256) &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes > 0 &&
    /^mask-[A-Za-z0-9._-]{1,110}$/.test(value.localRef) &&
    (image
      ? value.descriptor.mimeType === 'image/png'
      : value.descriptor.mimeType === 'video/webm') &&
    Number.isSafeInteger(value.descriptor.width) &&
    (value.descriptor.width ?? 0) > 0 &&
    Number.isSafeInteger(value.descriptor.height) &&
    (value.descriptor.height ?? 0) > 0 &&
    (!video ||
      (Number.isSafeInteger(value.descriptor.durationUs) && (value.descriptor.durationUs ?? 0) > 0))
  );
}

function isUpscaleReceipt(value: WorkerResultReceipt): value is UpscaleWorkerReceipt {
  const image = value.kind === 'upscale.image';
  const video = value.kind === 'upscale.video';
  return (
    (image || video) &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.assetId) &&
    /^[a-f0-9]{64}$/.test(value.sha256) &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes > 0 &&
    /^upscale-[A-Za-z0-9._-]{1,120}$/.test(value.localRef) &&
    typeof value.descriptor.mimeType === 'string' &&
    value.descriptor.mimeType.length > 0 &&
    Number.isSafeInteger(value.descriptor.width) &&
    (value.descriptor.width ?? 0) > 0 &&
    Number.isSafeInteger(value.descriptor.height) &&
    (value.descriptor.height ?? 0) > 0 &&
    (!video ||
      value.descriptor.mimeType === 'video/mp4' ||
      value.descriptor.mimeType === 'video/webm')
  );
}

function derivativeKindForJob(type: string): DerivativeKind | undefined {
  if (type === 'asset.thumbnail') return 'thumbnail';
  if (type === 'render.export') return 'proxy';
  if (type === 'audio.ml-denoise') return 'audio';
  if (type === 'mask.image' || type === 'mask.video') return 'mask';
  if (type === 'upscale.image' || type === 'upscale.video') return 'upscale';
  return undefined;
}

function requiresSourceAsset(type: string): boolean {
  return (
    type === 'image.comfy' ||
    type === 'audio.ml-denoise' ||
    type === 'mask.image' ||
    type === 'mask.video' ||
    type === 'upscale.image' ||
    type === 'upscale.video'
  );
}

function validatedJobPayload(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new ControlPlaneError('JOB_PAYLOAD_INVALID', 'job payload must be JSON serializable');
  }
  if (serialized.length > 64 * 1024)
    throw new ControlPlaneError('JOB_PAYLOAD_INVALID', 'job payload exceeds 64 KiB');
  const parsed: unknown = JSON.parse(serialized);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new ControlPlaneError('JOB_PAYLOAD_INVALID', 'job payload must be an object');
  return parsed as Readonly<Record<string, unknown>>;
}

function safeNonNegativeInteger(value: string | number, label: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0)
    throw new ControlPlaneError('DATABASE_ERROR', `stored ${label} is invalid`);
  return result;
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

function databaseError(error: unknown, duplicateCode: string, id: string): ControlPlaneError {
  if (isPostgresError(error) && error.code === '23505')
    return new ControlPlaneError(duplicateCode, id);
  if (error instanceof ControlPlaneError) return error;
  return new ControlPlaneError('DATABASE_ERROR', 'durable control-plane operation failed');
}

function isPostgresError(value: unknown): value is { readonly code: string } {
  return (
    value !== null && typeof value === 'object' && 'code' in value && typeof value.code === 'string'
  );
}
