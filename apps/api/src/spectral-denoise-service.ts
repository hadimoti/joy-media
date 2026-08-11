import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { ControlPlaneError } from './control-plane.js';
import {
  runSpectralDenoise,
  type SpectralDenoiseRequest,
  type SpectralDenoiseResult,
} from './spectral-denoise.js';

export type SpectralDenoiseOperationStatus = 'running' | 'succeeded' | 'failed';

export interface SpectralDenoiseOperation {
  readonly ownerId: string;
  readonly projectId: string;
  readonly operationId: string;
  readonly requestHash: string;
  readonly status: SpectralDenoiseOperationStatus;
  readonly result?: SpectralDenoiseResult;
  readonly error?: string;
  /** Internal fencing token. It is deliberately omitted from public responses. */
  readonly leaseToken?: string;
  /** A running operation may be atomically reclaimed after this instant. */
  readonly leaseExpiresAt?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface PublicSpectralDenoiseOperation {
  readonly projectId: string;
  readonly operationId: string;
  readonly status: SpectralDenoiseOperationStatus;
  readonly result?: SpectralDenoiseResult;
  readonly error?: string;
  readonly leaseExpiresAt?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface SpectralDenoiseOperationClaim {
  readonly claimed: boolean;
  readonly operation: SpectralDenoiseOperation;
}

export interface SpectralDenoiseInvocationLedger {
  find(
    ownerId: string,
    projectId: string,
    operationId: string,
  ): Promise<SpectralDenoiseOperation | undefined>;
  claim(
    ownerId: string,
    projectId: string,
    operationId: string,
    requestHash: string,
    leaseDurationMs: number,
  ): Promise<SpectralDenoiseOperationClaim>;
  complete(
    ownerId: string,
    projectId: string,
    operationId: string,
    requestHash: string,
    leaseToken: string,
    result: SpectralDenoiseResult,
  ): Promise<SpectralDenoiseOperation>;
  fail(
    ownerId: string,
    projectId: string,
    operationId: string,
    requestHash: string,
    leaseToken: string,
    error: string,
  ): Promise<void>;
}

/** Safe fallback for tests and local runs without PostgreSQL. */
export class MemorySpectralDenoiseInvocationLedger implements SpectralDenoiseInvocationLedger {
  readonly #operations = new Map<string, SpectralDenoiseOperation>();

  constructor(
    private readonly options: {
      readonly now?: () => number;
      readonly createLeaseToken?: () => string;
    } = {},
  ) {}

  async find(
    ownerId: string,
    projectId: string,
    operationId: string,
  ): Promise<SpectralDenoiseOperation | undefined> {
    return this.#operations.get(operationKey(ownerId, projectId, operationId));
  }

  async claim(
    ownerId: string,
    projectId: string,
    operationId: string,
    requestHash: string,
    leaseDurationMs: number,
  ): Promise<SpectralDenoiseOperationClaim> {
    const key = operationKey(ownerId, projectId, operationId);
    const existing = this.#operations.get(key);
    const now = this.options.now?.() ?? Date.now();
    if (
      existing !== undefined &&
      (existing.requestHash !== requestHash ||
        existing.status === 'succeeded' ||
        (existing.status === 'running' &&
          existing.leaseExpiresAt !== undefined &&
          existing.leaseExpiresAt > now))
    )
      return { claimed: false, operation: existing };
    const leaseToken = this.options.createLeaseToken?.() ?? randomUUID();
    const operation: SpectralDenoiseOperation = {
      ownerId,
      projectId,
      operationId,
      requestHash,
      status: 'running',
      leaseToken,
      leaseExpiresAt: now + leaseDurationMs,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    // Map.set occurs synchronously before this async method yields, so two
    // requests in one process cannot both claim the same logical operation.
    this.#operations.set(key, operation);
    return { claimed: true, operation };
  }

  async complete(
    ownerId: string,
    projectId: string,
    operationId: string,
    requestHash: string,
    leaseToken: string,
    result: SpectralDenoiseResult,
  ): Promise<SpectralDenoiseOperation> {
    const key = operationKey(ownerId, projectId, operationId);
    const current = this.#operations.get(key);
    if (current?.requestHash === requestHash && current.status === 'succeeded') return current;
    assertCompletable(current, requestHash, leaseToken);
    const completed: SpectralDenoiseOperation = {
      ownerId: current.ownerId,
      projectId: current.projectId,
      operationId: current.operationId,
      requestHash: current.requestHash,
      status: 'succeeded',
      result,
      createdAt: current.createdAt,
      updatedAt: this.options.now?.() ?? Date.now(),
    };
    this.#operations.set(key, completed);
    return completed;
  }

  async fail(
    ownerId: string,
    projectId: string,
    operationId: string,
    requestHash: string,
    leaseToken: string,
    error: string,
  ): Promise<void> {
    const key = operationKey(ownerId, projectId, operationId);
    const current = this.#operations.get(key);
    if (
      current === undefined ||
      current.requestHash !== requestHash ||
      current.status !== 'running' ||
      current.leaseToken !== leaseToken
    )
      return;
    this.#operations.set(key, {
      ownerId: current.ownerId,
      projectId: current.projectId,
      operationId: current.operationId,
      requestHash: current.requestHash,
      status: 'failed',
      error: error.slice(0, 500),
      createdAt: current.createdAt,
      updatedAt: this.options.now?.() ?? Date.now(),
    });
  }
}

interface SpectralDenoiseOperationRow {
  readonly owner_id: string;
  readonly project_id: string;
  readonly operation_id: string;
  readonly request_hash: string;
  readonly status: SpectralDenoiseOperationStatus;
  readonly result: SpectralDenoiseResult | null;
  readonly error: string | null;
  readonly lease_token: string | null;
  readonly lease_expires_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/** Durable provider claim/result ledger. It stores no source media or credentials. */
export class PostgresSpectralDenoiseInvocationLedger implements SpectralDenoiseInvocationLedger {
  constructor(private readonly pool: Pool) {}

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS provider_audio_denoise_operations (
        owner_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        result JSONB,
        error TEXT,
        lease_token TEXT,
        lease_expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (owner_id, project_id, operation_id)
      )
    `);
    // Existing installations predate leases. A NULL lease on a running row is
    // intentionally reclaimable, so a crash cannot wedge the logical operation.
    await this.pool.query(
      'ALTER TABLE provider_audio_denoise_operations ADD COLUMN IF NOT EXISTS lease_token TEXT',
    );
    await this.pool.query(
      'ALTER TABLE provider_audio_denoise_operations ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ',
    );
  }

  async find(
    ownerId: string,
    projectId: string,
    operationId: string,
  ): Promise<SpectralDenoiseOperation | undefined> {
    const found = await this.pool.query<SpectralDenoiseOperationRow>(
      `SELECT * FROM provider_audio_denoise_operations
       WHERE owner_id = $1 AND project_id = $2 AND operation_id = $3`,
      [ownerId, projectId, operationId],
    );
    return found.rows[0] === undefined ? undefined : operationFromRow(found.rows[0]);
  }

  async claim(
    ownerId: string,
    projectId: string,
    operationId: string,
    requestHash: string,
    leaseDurationMs: number,
  ): Promise<SpectralDenoiseOperationClaim> {
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(Date.now() + leaseDurationMs);
    const inserted = await this.pool.query<SpectralDenoiseOperationRow>(
      `INSERT INTO provider_audio_denoise_operations
       (owner_id, project_id, operation_id, request_hash, status, lease_token, lease_expires_at)
       VALUES ($1, $2, $3, $4, 'running', $5, $6)
       ON CONFLICT (owner_id, project_id, operation_id) DO UPDATE
       SET status = 'running', result = NULL, error = NULL,
           lease_token = EXCLUDED.lease_token,
           lease_expires_at = EXCLUDED.lease_expires_at,
           updated_at = now()
       WHERE provider_audio_denoise_operations.request_hash = EXCLUDED.request_hash
         AND (
           provider_audio_denoise_operations.status = 'failed'
           OR (
             provider_audio_denoise_operations.status = 'running'
             AND (
               provider_audio_denoise_operations.lease_expires_at IS NULL
               OR provider_audio_denoise_operations.lease_expires_at <= now()
             )
           )
         )
       RETURNING *`,
      [ownerId, projectId, operationId, requestHash, leaseToken, leaseExpiresAt],
    );
    if (inserted.rows[0]?.lease_token === leaseToken)
      return { claimed: true, operation: operationFromRow(inserted.rows[0]) };
    // PostgreSQL returns no row when ON CONFLICT's WHERE predicate is false.
    // pg-mem returns the unchanged row; accepting only our fresh fencing token
    // keeps both behaviours atomic and makes the contract explicit.
    if (inserted.rows[0] !== undefined)
      return { claimed: false, operation: operationFromRow(inserted.rows[0]) };
    const existing = await this.find(ownerId, projectId, operationId);
    if (existing === undefined) throw new Error('audio denoise operation claim was not persisted');
    return { claimed: false, operation: existing };
  }

  async complete(
    ownerId: string,
    projectId: string,
    operationId: string,
    requestHash: string,
    leaseToken: string,
    result: SpectralDenoiseResult,
  ): Promise<SpectralDenoiseOperation> {
    const completed = await this.pool.query<SpectralDenoiseOperationRow>(
      `UPDATE provider_audio_denoise_operations
       SET status = 'succeeded', result = $6::jsonb, error = NULL,
           lease_token = NULL, lease_expires_at = NULL, updated_at = now()
       WHERE owner_id = $1 AND project_id = $2 AND operation_id = $3
         AND request_hash = $4 AND lease_token = $5 AND status = 'running'
       RETURNING *`,
      [ownerId, projectId, operationId, requestHash, leaseToken, JSON.stringify(result)],
    );
    if (completed.rows[0] !== undefined) return operationFromRow(completed.rows[0]);
    const existing = await this.find(ownerId, projectId, operationId);
    if (
      existing !== undefined &&
      existing.requestHash === requestHash &&
      existing.status === 'succeeded'
    )
      return existing;
    throw new Error('audio denoise completion was not persisted');
  }

  async fail(
    ownerId: string,
    projectId: string,
    operationId: string,
    requestHash: string,
    leaseToken: string,
    error: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE provider_audio_denoise_operations
       SET status = 'failed', error = $6, lease_token = NULL,
           lease_expires_at = NULL, updated_at = now()
       WHERE owner_id = $1 AND project_id = $2 AND operation_id = $3
         AND request_hash = $4 AND lease_token = $5 AND status = 'running'`,
      [ownerId, projectId, operationId, requestHash, leaseToken, error.slice(0, 500)],
    );
  }
}

export interface SpectralDenoiseServiceRequest extends SpectralDenoiseRequest {
  readonly projectId: string;
  readonly operationId: string;
}

export interface SpectralDenoiseServiceOptions {
  readonly run?: (request: SpectralDenoiseRequest) => Promise<SpectralDenoiseResult>;
  readonly maxGlobalConcurrency?: number;
  readonly maxPerOwnerConcurrency?: number;
  readonly leaseDurationMs?: number;
}

/**
 * Process-local resource gate plus durable operation ledger. PostgreSQL's
 * atomic INSERT claim is the cross-tab/cross-process idempotency authority.
 */
export class SpectralDenoiseService {
  readonly #run: (request: SpectralDenoiseRequest) => Promise<SpectralDenoiseResult>;
  readonly #gate: DenoiseConcurrencyGate;
  readonly #leaseDurationMs: number;

  constructor(
    private readonly ledger: SpectralDenoiseInvocationLedger,
    options: SpectralDenoiseServiceOptions = {},
  ) {
    this.#run = options.run ?? ((request) => runSpectralDenoise(request));
    this.#gate = new DenoiseConcurrencyGate(
      options.maxGlobalConcurrency ??
        positiveEnvironmentInteger('JOY_MEDIA_DENOISE_MAX_GLOBAL_CONCURRENCY', 2),
      options.maxPerOwnerConcurrency ??
        positiveEnvironmentInteger('JOY_MEDIA_DENOISE_MAX_OWNER_CONCURRENCY', 1),
    );
    this.#leaseDurationMs =
      options.leaseDurationMs ?? positiveEnvironmentInteger('JOY_MEDIA_DENOISE_LEASE_MS', 90_000);
    if (!Number.isSafeInteger(this.#leaseDurationMs) || this.#leaseDurationMs <= 0)
      throw new TypeError('denoise lease duration must be a positive integer');
  }

  async find(
    ownerId: string,
    projectId: string,
    operationId: string,
  ): Promise<PublicSpectralDenoiseOperation | undefined> {
    const operation = await this.ledger.find(ownerId, projectId, operationId);
    return operation === undefined ? undefined : publicOperation(operation);
  }

  async run(
    ownerId: string,
    request: SpectralDenoiseServiceRequest,
  ): Promise<PublicSpectralDenoiseOperation> {
    validateOpaqueOperationIdentity(request.projectId, 'projectId');
    validateOpaqueOperationIdentity(request.operationId, 'operationId');
    const requestHash = denoiseRequestHash(request);
    const previous = await this.ledger.find(ownerId, request.projectId, request.operationId);
    if (
      previous !== undefined &&
      (previous.requestHash !== requestHash || previous.status === 'succeeded')
    )
      return resolveExisting(previous, requestHash);

    const release = this.#gate.tryAcquire(ownerId);
    if (release === undefined)
      throw new ControlPlaneError(
        'PROVIDER_BUSY',
        'Cloud denoise is busy for this account; retry in a moment.',
      );

    let leaseToken: string | undefined;
    try {
      const claim = await this.ledger.claim(
        ownerId,
        request.projectId,
        request.operationId,
        requestHash,
        this.#leaseDurationMs,
      );
      if (!claim.claimed) return resolveExisting(claim.operation, requestHash);
      leaseToken = requiredLeaseToken(claim.operation);
      const result = await this.#run({
        assetId: request.assetId,
        mediaBase64: request.mediaBase64,
        ...(request.sampleRate === undefined ? {} : { sampleRate: request.sampleRate }),
        ...(request.strength === undefined ? {} : { strength: request.strength }),
      });
      return publicOperation(
        await this.ledger.complete(
          ownerId,
          request.projectId,
          request.operationId,
          requestHash,
          leaseToken,
          result,
        ),
      );
    } catch (error) {
      if (leaseToken !== undefined)
        await this.ledger.fail(
          ownerId,
          request.projectId,
          request.operationId,
          requestHash,
          leaseToken,
          error instanceof Error ? error.message : String(error),
        );
      throw error;
    } finally {
      release();
    }
  }
}

class DenoiseConcurrencyGate {
  #global = 0;
  readonly #owners = new Map<string, number>();

  constructor(
    private readonly maxGlobal: number,
    private readonly maxPerOwner: number,
  ) {
    if (!Number.isSafeInteger(maxGlobal) || maxGlobal <= 0)
      throw new TypeError('global denoise concurrency must be a positive integer');
    if (!Number.isSafeInteger(maxPerOwner) || maxPerOwner <= 0)
      throw new TypeError('per-owner denoise concurrency must be a positive integer');
  }

  tryAcquire(ownerId: string): (() => void) | undefined {
    const owner = this.#owners.get(ownerId) ?? 0;
    if (this.#global >= this.maxGlobal || owner >= this.maxPerOwner) return undefined;
    this.#global += 1;
    this.#owners.set(ownerId, owner + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#global -= 1;
      const remaining = (this.#owners.get(ownerId) ?? 1) - 1;
      if (remaining === 0) this.#owners.delete(ownerId);
      else this.#owners.set(ownerId, remaining);
    };
  }
}

function resolveExisting(
  operation: SpectralDenoiseOperation,
  requestHash: string,
): PublicSpectralDenoiseOperation {
  if (operation.requestHash !== requestHash)
    throw new ControlPlaneError(
      'IDEMPOTENCY_CONFLICT',
      'operationId was already used for different Cloud denoise input',
    );
  if (operation.status === 'succeeded') return publicOperation(operation);
  if (operation.status === 'running')
    throw new ControlPlaneError(
      'PROVIDER_BUSY',
      'This Cloud denoise operation is already running; use the recovery endpoint.',
    );
  throw new ControlPlaneError(
    'PROVIDER_OPERATION_FAILED',
    operation.error ?? 'The previous Cloud denoise attempt failed.',
  );
}

function publicOperation(operation: SpectralDenoiseOperation): PublicSpectralDenoiseOperation {
  return {
    projectId: operation.projectId,
    operationId: operation.operationId,
    status: operation.status,
    ...(operation.result === undefined ? {} : { result: operation.result }),
    ...(operation.error === undefined ? {} : { error: operation.error }),
    ...(operation.leaseExpiresAt === undefined ? {} : { leaseExpiresAt: operation.leaseExpiresAt }),
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
  };
}

function denoiseRequestHash(request: SpectralDenoiseServiceRequest): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        assetId: request.assetId,
        mediaSha256: createHash('sha256').update(request.mediaBase64).digest('hex'),
        sampleRate: request.sampleRate ?? 48_000,
        strength: request.strength ?? 0.8,
      }),
    )
    .digest('hex');
}

function operationKey(ownerId: string, projectId: string, operationId: string): string {
  return JSON.stringify([ownerId, projectId, operationId]);
}

function operationFromRow(row: SpectralDenoiseOperationRow): SpectralDenoiseOperation {
  return {
    ownerId: row.owner_id,
    projectId: row.project_id,
    operationId: row.operation_id,
    requestHash: row.request_hash,
    status: row.status,
    ...(row.result === null ? {} : { result: row.result }),
    ...(row.error === null ? {} : { error: row.error }),
    ...(row.lease_token === null ? {} : { leaseToken: row.lease_token }),
    ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: row.lease_expires_at.getTime() }),
    createdAt: row.created_at.getTime(),
    updatedAt: row.updated_at.getTime(),
  };
}

function assertCompletable(
  operation: SpectralDenoiseOperation | undefined,
  requestHash: string,
  leaseToken: string,
): asserts operation is SpectralDenoiseOperation {
  if (
    operation === undefined ||
    operation.requestHash !== requestHash ||
    operation.status !== 'running' ||
    operation.leaseToken !== leaseToken
  )
    throw new Error('audio denoise operation is not completable');
}

function requiredLeaseToken(operation: SpectralDenoiseOperation): string {
  if (operation.status !== 'running' || operation.leaseToken === undefined)
    throw new Error('audio denoise operation claim has no lease token');
  return operation.leaseToken;
}

function validateOpaqueOperationIdentity(value: string, field: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    Array.from(value).some((character) => character.charCodeAt(0) < 32)
  )
    throw new ControlPlaneError('REQUEST_INVALID', `${field} is invalid`);
}

function positiveEnvironmentInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new TypeError(`${name} must be a positive integer`);
  return value;
}
