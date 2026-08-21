import type { Pool, PoolClient } from 'pg';
import {
  isWorkerJobType,
  validateWorkerJobV1,
  validateWorkerReceiptForJob,
  workerCanRunJob,
  WORKER_PROTOCOL_VERSION,
} from '@joy-media/job-protocol';
import type { WorkerJobV1 } from '@joy-media/job-protocol';
import {
  ControlPlaneError,
  type AssetLocationRecord,
  type AssetRegistration,
  type Actor,
  type AssetThumbnailReceipt,
  type CloudDerivativeRegistration,
  type ControlPlane,
  type LocalDerivativeRegistration,
  type MediaAssetRecord,
  type MediaDerivativeRecord,
  type Job,
  type JobEvent,
  type LocalGpuWorkerReceipt,
  type WorkerResultReceipt,
  type ProjectMetadata,
  type WorkerPairingOffer,
  type WorkerRecord,
  type WorkerSession,
  validateAssetRegistration,
  validateAssetTags,
  validateCloudDerivativeRegistration,
  validateLocalDerivativeRegistration,
  validateSortName,
} from './control-plane.js';
import { POSTGRES_SCHEMA } from './postgres-schema.js';
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

const FIXTURE_THUMBNAIL_SHA256 = '78bf4c43aa7ab3a14c9f1e34f3333f9f612a08191affba3fb9c3e6de88378735';
const FIXTURE_THUMBNAIL_BYTES = 14;

interface ProjectRow {
  readonly id: string;
  readonly owner_id: string;
  readonly title: string;
  readonly revision: number;
  readonly asset_sync_enabled: boolean;
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
export class PostgresControlPlane implements ControlPlane, ProductionRunStore {
  readonly #skipLocked: boolean;
  readonly #productionRuns: PostgresProductionRunStore;

  constructor(
    private readonly pool: Pool,
    options: PostgresControlPlaneOptions = {},
  ) {
    this.#skipLocked = options.skipLocked ?? true;
    this.#productionRuns = new PostgresProductionRunStore(pool);
  }

  async initialize(): Promise<void> {
    await this.pool.query(POSTGRES_SCHEMA);
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
    return this.transaction(async (client) => {
      await this.project(actor, projectId, client);
      const existing = await client.query<{ id: string }>(
        'SELECT id FROM media_assets WHERE id = $1 AND project_id = $2',
        [assetId, projectId],
      );
      if (existing.rows[0] === undefined) throw new ControlPlaneError('ASSET_NOT_FOUND', assetId);
      await client.query('DELETE FROM media_derivatives WHERE project_id = $1 AND asset_id = $2', [
        projectId,
        assetId,
      ]);
      await client.query('DELETE FROM media_assets WHERE id = $1 AND project_id = $2', [
        assetId,
        projectId,
      ]);
      return { id: assetId };
    });
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
      `SELECT * FROM media_assets
       WHERE EXISTS (
         SELECT 1 FROM jsonb_array_elements(locations) AS loc
         WHERE loc->>'kind' = 'private-object'
       )
       ORDER BY COALESCE(CASE WHEN sort_name = '' THEN NULL ELSE sort_name END, lower(display_name)), id`,
    );
    return result.rows.map(mediaAssetOf);
  }

  async sharedCloudAsset(actor: Actor, assetId: string): Promise<MediaAssetRecord> {
    assertActor(actor);
    const result = await this.pool.query<MediaAssetRow>(
      `SELECT * FROM media_assets
       WHERE id = $1
         AND EXISTS (
           SELECT 1 FROM jsonb_array_elements(locations) AS loc
           WHERE loc->>'kind' = 'private-object'
         )`,
      [assetId],
    );
    if (result.rows[0] === undefined) throw new ControlPlaneError('ASSET_NOT_FOUND', assetId);
    return mediaAssetOf(result.rows[0]);
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
        return mediaDerivativeOf(requiredRow(result.rows[0], 'DERIVATIVE_CREATE_FAILED'));
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
    if (!isWorkerJobType(type) && type !== 'fixture.thumbnail')
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
      if ((type === 'image.comfy' || type === 'audio.ml-denoise') && assetId === undefined)
        throw new ControlPlaneError('ASSET_JOB_INVALID', 'Worker generation requires an asset ID');
      if ((type === 'image.comfy' || type === 'audio.ml-denoise') && assetId !== undefined) {
        await this.asset(actor, projectId, assetId, client);
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
         WHERE (state = 'queued' OR (state = 'leased' AND lease_expires_at <= $1))
         ORDER BY id LIMIT 64 FOR UPDATE${this.#skipLocked ? ' SKIP LOCKED' : ''}`,
        [new Date(now)],
      );
      // Keep opaque-locality matching in the Worker/control-plane domain; this
      // also keeps the durable contract executable in pg-mem without changing
      // PostgreSQL's queue lock semantics.
      const job = candidate.rows.find((item) => {
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
        if (isWorkerJobType(item.type)) return workerCanRunJob(caps, item.type);
        return item.type === 'fixture.thumbnail';
      });
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
    const isThumb = receipt?.kind === 'asset.thumbnail';
    const isGpu = receipt?.kind === 'image.comfy' || receipt?.kind === 'audio.ml-denoise';
    const isMediaAi = receipt?.kind === 'video.runway' || receipt?.kind === 'edit.higgsfield';
    const storesAsset = isThumb || isGpu || isMediaAi;
    const storesHashAndBytes = receipt !== undefined && 'sha256' in receipt && 'bytes' in receipt;
    const storesDescriptor = storesAsset && receipt !== undefined && 'descriptor' in receipt;
    return this.transaction(async (client) => {
      const result = await client.query<JobRow>(
        `UPDATE jobs SET state = 'completed', progress = 100, cancel_requested = false,
             result_kind = $4, result_sha256 = $5, result_bytes = $6,
             result_ref = $7, result_worker_ref = $8, result_verified_at = $9,
             result_asset_id = $10, result_local_ref = $11, result_mime_type = $12,
             result_width = $13, result_height = $14, result_receipt = $15::jsonb
         WHERE id = $1 AND state = 'leased' AND lease_owner = $2 AND lease_expires_at > $3
           AND (type <> 'fixture.thumbnail' OR $4 = 'fixture.thumbnail')
           AND (type <> 'asset.thumbnail' OR ($4 = 'asset.thumbnail' AND asset_id = $10))
           AND (type <> 'image.comfy' OR $4 = 'image.comfy')
           AND (type <> 'audio.ml-denoise' OR $4 = 'audio.ml-denoise')
           AND (type NOT IN ('render.export', 'render.inspect', 'text.lm-studio', 'text.openrouter',
                             'video.runway', 'edit.higgsfield') OR type = $4)
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
         WHERE id = $1 AND project_id = $2 AND state IN ('completed', 'canceled', 'failed')
         RETURNING *`,
        [jobId, projectId],
      );
      if (result.rows[0] === undefined) throw new ControlPlaneError('JOB_NOT_RETRYABLE', jobId);
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
    ...(row.result_kind === null ||
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
  if (row.result_kind === 'fixture.thumbnail')
    return { ...base, ...hashAndBytes, kind: row.result_kind };
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
    isLocalGpuReceipt(value) ||
    isTextAiReceipt(value) ||
    isMediaAiReceipt(value) ||
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
    Number.isSafeInteger(value.findings) &&
    value.findings >= 0
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
  if (type === 'render.export' || type === 'render.inspect') {
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
  return validateWorkerJobV1({
    protocolVersion: WORKER_PROTOCOL_VERSION,
    jobId: id,
    type,
    payload: {
      prompt: '',
      ...(assetId === undefined ? {} : { imageAssetId: assetId }),
    },
    requirements: {
      capabilities: [type],
      privacy:
        type === 'text.openrouter' || type === 'video.runway' || type === 'edit.higgsfield'
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

function isPostgresError(value: unknown): value is { readonly code: string } {
  return (
    value !== null && typeof value === 'object' && 'code' in value && typeof value.code === 'string'
  );
}
