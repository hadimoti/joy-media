import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  createMistralAdapter,
  MISTRAL_PROVIDER_ID,
  MISTRAL_REASONING_MODELS,
  type MistralChatMessage,
} from '@joy-media/adapter-mistral';
import {
  computePrivacyPreflight,
  ProviderLifecycle,
  resolveProvider,
  type CapabilityResult,
  type ProviderStatus,
} from '@joy-media/provider-sdk';

export interface MistralCompletionRequest {
  readonly model: string;
  readonly messages: readonly MistralChatMessage[];
  readonly idempotencyKey: string;
  readonly privacyMode: 'local-only' | 'ask-before-remote';
  readonly approvedRemoteProcessing: boolean;
  readonly approvedSpend: boolean;
  readonly maxTokens?: number;
  readonly temperature?: number;
}

export interface MistralProviderSummary {
  readonly providerId: typeof MISTRAL_PROVIDER_ID;
  readonly state: ProviderStatus['state'];
  readonly models: readonly {
    readonly id: string;
    readonly displayName: string;
    readonly version?: string;
  }[];
  readonly adapterVersion: string;
}

export class MistralProviderError extends Error {
  constructor(
    readonly code:
      | 'PROVIDER_UNCONFIGURED'
      | 'REMOTE_PROCESSING_BLOCKED'
      | 'REMOTE_PROCESSING_APPROVAL_REQUIRED'
      | 'PROVIDER_SPEND_APPROVAL_REQUIRED'
      | 'IDEMPOTENCY_CONFLICT'
      | 'MISTRAL_UNAUTHORIZED'
      | 'MISTRAL_UNAVAILABLE'
      | 'MISTRAL_REQUEST_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'MistralProviderError';
  }
}

export interface MistralInvocationLedger {
  find(actorId: string, idempotencyKey: string): Promise<CapabilityResult | undefined>;
  record(actorId: string, result: CapabilityResult): Promise<CapabilityResult>;
}

interface ClaimableMistralInvocationLedger extends MistralInvocationLedger {
  runClaimed(
    actorId: string,
    idempotencyKey: string,
    requestHash: string,
    invoke: () => Promise<CapabilityResult>,
  ): Promise<CapabilityResult>;
}

type MistralInvocationClaimStatus = 'running' | 'failed' | 'completed';

interface MistralInvocationClaim {
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly status: MistralInvocationClaimStatus;
  readonly leaseToken?: string;
  readonly leaseExpiresAt?: number;
}

interface MistralInvocationClaimRow {
  readonly actor_id: string;
  readonly idempotency_key: string;
  readonly request_hash: string;
  readonly status: MistralInvocationClaimStatus;
  readonly lease_token: string | null;
  readonly lease_expires_at: Date | null;
}

interface MistralInvocationClaimAttempt {
  readonly claimed: boolean;
  readonly claim: MistralInvocationClaim;
}

const MISTRAL_INVOCATION_LEASE_MS = 5 * 60_000;
const MISTRAL_INVOCATION_POLL_MS = 250;

/** Safe fallback for local/dev runs without PostgreSQL. Production uses the Postgres ledger. */
export class MemoryMistralInvocationLedger implements MistralInvocationLedger {
  readonly #records = new Map<string, CapabilityResult>();
  async find(actorId: string, idempotencyKey: string): Promise<CapabilityResult | undefined> {
    return this.#records.get(`${actorId}:${idempotencyKey}`);
  }
  async record(actorId: string, result: CapabilityResult): Promise<CapabilityResult> {
    const key = `${actorId}:${result.provenance.idempotencyKey}`;
    const existing = this.#records.get(key);
    if (existing !== undefined)
      return ensureMatchingInvocation(existing, result.provenance.requestHash);
    this.#records.set(key, result);
    return result;
  }
}

/**
 * Stores retry/provenance data without retaining prompts or credentials. The
 * completion itself is retained so the exact idempotent result can be replayed
 * to the same authenticated owner after an API restart.
 */
export class PostgresMistralInvocationLedger implements MistralInvocationLedger {
  constructor(private readonly pool: Pool) {}

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS provider_invocations (
        actor_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        result JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (actor_id, idempotency_key)
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS provider_invocation_claims (
        actor_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        lease_token TEXT,
        lease_expires_at TIMESTAMPTZ,
        error TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (actor_id, idempotency_key)
      )
    `);
    await this.pool.query(
      "ALTER TABLE provider_invocation_claims ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'running'",
    );
    await this.pool.query(
      'ALTER TABLE provider_invocation_claims ADD COLUMN IF NOT EXISTS lease_token TEXT',
    );
    await this.pool.query(
      'ALTER TABLE provider_invocation_claims ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ',
    );
    await this.pool.query(
      'ALTER TABLE provider_invocation_claims ADD COLUMN IF NOT EXISTS error TEXT',
    );
    await this.pool.query(
      'ALTER TABLE provider_invocation_claims ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()',
    );
  }

  async find(actorId: string, idempotencyKey: string): Promise<CapabilityResult | undefined> {
    const result = await this.pool.query<{ readonly result: CapabilityResult }>(
      'SELECT result FROM provider_invocations WHERE actor_id = $1 AND idempotency_key = $2',
      [actorId, idempotencyKey],
    );
    return result.rows[0]?.result;
  }

  async record(actorId: string, result: CapabilityResult): Promise<CapabilityResult> {
    return persistInvocation(this.pool, actorId, result);
  }

  async runClaimed(
    actorId: string,
    idempotencyKey: string,
    requestHash: string,
    invoke: () => Promise<CapabilityResult>,
  ): Promise<CapabilityResult> {
    for (;;) {
      const existing = await findInvocation(this.pool, actorId, idempotencyKey);
      if (existing !== undefined) return ensureMatchingInvocation(existing, requestHash);
      const claim = await claimInvocation(this.pool, actorId, idempotencyKey, requestHash);
      if (!claim.claimed) {
        const replayed = await waitForInvocationReplay(
          this.pool,
          actorId,
          idempotencyKey,
          requestHash,
          claim.claim,
        );
        if (replayed !== undefined) return ensureMatchingInvocation(replayed, requestHash);
        continue;
      }
      const leaseToken = requiredLeaseToken(claim.claim);
      try {
        const result = await invoke();
        const stored = await persistInvocationAndCompleteClaim(
          this.pool,
          actorId,
          result,
          leaseToken,
        );
        return ensureMatchingInvocation(stored, requestHash);
      } catch (error) {
        await releaseClaim(this.pool, actorId, idempotencyKey, requestHash, leaseToken);
        throw error;
      }
    }
  }
}

export class MistralProviderRegistry {
  readonly #provider;
  readonly #lifecycle = new ProviderLifecycle();
  readonly #inFlight = new Map<
    string,
    { readonly requestHash: string; readonly promise: Promise<CapabilityResult> }
  >();

  constructor(
    apiKey: string | undefined,
    private readonly ledger: MistralInvocationLedger = new MemoryMistralInvocationLedger(),
    fetchImpl?: typeof fetch,
  ) {
    // An empty value is used only to construct the manifest for the
    // unconfigured state. invoke() is guarded before this adapter can run.
    this.#provider = createMistralAdapter({
      apiKey: apiKey?.trim() ?? '',
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
    });
    this.#lifecycle.register(this.#provider);
    if (apiKey === undefined || apiKey.trim().length === 0)
      this.#lifecycle.markUnconfigured(MISTRAL_PROVIDER_ID);
  }

  summary(): MistralProviderSummary {
    const status = this.#lifecycle.getStatus(MISTRAL_PROVIDER_ID);
    const configured = status.state === 'configured' || status.state === 'healthy';
    return {
      providerId: MISTRAL_PROVIDER_ID,
      state: status.state,
      models: configured ? MISTRAL_REASONING_MODELS : [],
      adapterVersion: status.adapterVersion,
    };
  }

  async complete(actorId: string, input: MistralCompletionRequest): Promise<CapabilityResult> {
    const status = this.#lifecycle.getStatus(MISTRAL_PROVIDER_ID);
    if (status.state === 'unconfigured') {
      throw new MistralProviderError(
        'PROVIDER_UNCONFIGURED',
        'Mistral is not configured on this server.',
      );
    }
    if (input.privacyMode === 'local-only') {
      throw new MistralProviderError(
        'REMOTE_PROCESSING_BLOCKED',
        'Local-only policy blocks Mistral remote processing.',
      );
    }
    if (!input.approvedRemoteProcessing) {
      throw new MistralProviderError(
        'REMOTE_PROCESSING_APPROVAL_REQUIRED',
        'Remote processing requires explicit approval.',
      );
    }
    if (!input.approvedSpend) {
      throw new MistralProviderError(
        'PROVIDER_SPEND_APPROVAL_REQUIRED',
        'Provider spend requires explicit approval.',
      );
    }
    const requestHash = mistralCompletionRequestHash(input);
    const previous = await this.ledger.find(actorId, input.idempotencyKey);
    if (previous !== undefined) return ensureMatchingInvocation(previous, requestHash);
    const invocationKey = `${actorId}:${input.idempotencyKey}`;
    const running = this.#inFlight.get(invocationKey);
    if (running !== undefined) {
      if (running.requestHash !== requestHash) {
        throw new MistralProviderError(
          'IDEMPOTENCY_CONFLICT',
          'idempotencyKey was already used for different Mistral input',
        );
      }
      return running.promise;
    }

    const request = {
      requestVersion: 1 as const,
      capability: 'llm.complete' as const,
      input: {
        model: input.model,
        messages: input.messages,
        ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
        ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
      },
      constraints: { executionPreference: ['remote'] as const, modelAllowlist: [input.model] },
      idempotencyKey: input.idempotencyKey,
    };
    const resolution = resolveProvider(request, [this.#provider], {
      allowRemote: true,
      blockedProviders: [],
      blockedCapabilities: [],
      requireLocalFor: [],
    });
    if (resolution.status !== 'resolved' || resolution.provider === undefined) {
      throw new MistralProviderError(
        'REMOTE_PROCESSING_BLOCKED',
        resolution.reason ?? 'Mistral is not eligible for this request.',
      );
    }
    // Compute the SDK preflight here, before egress. Approval was verified above;
    // no prompt/body is written to logs or the durable invocation ledger.
    const preflight = computePrivacyPreflight(request, resolution.provider);
    if (preflight.requiresUserApproval && !input.approvedRemoteProcessing) {
      throw new MistralProviderError(
        'REMOTE_PROCESSING_APPROVAL_REQUIRED',
        'Remote processing requires explicit approval.',
      );
    }
    const durableLedger = claimableLedger(this.ledger);
    const promise =
      durableLedger === undefined
        ? this.#completeRemote(request).then((result) => this.ledger.record(actorId, result))
        : durableLedger.runClaimed(actorId, input.idempotencyKey, requestHash, () =>
            this.#completeRemote(request),
          );
    this.#inFlight.set(invocationKey, { requestHash, promise });
    try {
      return await promise;
    } finally {
      const current = this.#inFlight.get(invocationKey);
      if (current?.promise === promise) this.#inFlight.delete(invocationKey);
    }
  }

  async #completeRemote(request: {
    readonly requestVersion: 1;
    readonly capability: 'llm.complete';
    readonly input: {
      readonly model: string;
      readonly messages: readonly MistralChatMessage[];
      readonly maxTokens?: number;
      readonly temperature?: number;
    };
    readonly constraints: {
      readonly executionPreference: readonly ['remote'];
      readonly modelAllowlist: readonly string[];
    };
    readonly idempotencyKey: string;
  }): Promise<CapabilityResult> {
    this.#lifecycle.recordJobStart(MISTRAL_PROVIDER_ID);
    try {
      const result = await this.#provider.invoke('llm.complete', request.input, request);
      if (result.status === 'succeeded') {
        this.#lifecycle.markHealthy(MISTRAL_PROVIDER_ID);
        this.#lifecycle.recordJobEnd(MISTRAL_PROVIDER_ID, true);
        return result;
      }
      const code = result.diagnostics[0]?.code;
      this.#lifecycle.recordJobEnd(MISTRAL_PROVIDER_ID, false);
      if (code === 'MISTRAL_UNAUTHORIZED') {
        this.#lifecycle.markUnauthorized(
          MISTRAL_PROVIDER_ID,
          'Mistral authentication failed.',
          false,
        );
        throw new MistralProviderError('MISTRAL_UNAUTHORIZED', 'Mistral authorization failed.');
      }
      this.#lifecycle.markDegraded(MISTRAL_PROVIDER_ID, 'Mistral completion failed.', false);
      throw new MistralProviderError(
        code === 'MISTRAL_UNAVAILABLE' || code === 'MISTRAL_TIMEOUT'
          ? 'MISTRAL_UNAVAILABLE'
          : 'MISTRAL_REQUEST_FAILED',
        'Mistral completion failed.',
      );
    } catch (error) {
      if (error instanceof MistralProviderError) throw error;
      this.#lifecycle.recordJobEnd(MISTRAL_PROVIDER_ID, false);
      this.#lifecycle.markDegraded(MISTRAL_PROVIDER_ID, 'Mistral completion failed.', false);
      throw new MistralProviderError('MISTRAL_UNAVAILABLE', 'Mistral is unavailable.');
    }
  }
}

export function createRuntimeMistralProviderRegistry(
  options: {
    readonly apiKey?: string;
    readonly ledger?: MistralInvocationLedger;
    readonly fetchImpl?: typeof fetch;
  } = {},
): MistralProviderRegistry {
  return new MistralProviderRegistry(options.apiKey, options.ledger, options.fetchImpl);
}

function ensureMatchingInvocation(result: CapabilityResult, requestHash: string): CapabilityResult {
  if (result.provenance.requestHash !== requestHash) {
    throw new MistralProviderError(
      'IDEMPOTENCY_CONFLICT',
      'idempotencyKey was already used for different Mistral input',
    );
  }
  return result;
}

async function claimInvocation(
  pool: Pool,
  actorId: string,
  idempotencyKey: string,
  requestHash: string,
): Promise<MistralInvocationClaimAttempt> {
  const leaseToken = randomUUID();
  const leaseExpiresAt = new Date(Date.now() + MISTRAL_INVOCATION_LEASE_MS);
  const inserted = await pool.query<MistralInvocationClaimRow>(
    `INSERT INTO provider_invocation_claims
       (actor_id, idempotency_key, request_hash, status, lease_token, lease_expires_at, error)
     VALUES ($1, $2, $3, 'running', $4, $5, NULL)
     ON CONFLICT (actor_id, idempotency_key) DO NOTHING
     RETURNING actor_id, idempotency_key, request_hash, status, lease_token, lease_expires_at`,
    [actorId, idempotencyKey, requestHash, leaseToken, leaseExpiresAt],
  );
  if (inserted.rows[0] !== undefined)
    return { claimed: true, claim: claimFromRow(inserted.rows[0]) };

  const current = await selectClaim(pool, actorId, idempotencyKey);
  if (current === undefined) return claimInvocation(pool, actorId, idempotencyKey, requestHash);
  const claim = claimFromRow(current);
  if (claim.requestHash !== requestHash) return { claimed: false, claim };
  if (claim.status === 'running' && (claim.leaseExpiresAt ?? 0) > Date.now())
    return { claimed: false, claim };

  const recovered = await pool.query<MistralInvocationClaimRow>(
    `UPDATE provider_invocation_claims
     SET status = 'running', lease_token = $4, lease_expires_at = $5,
         error = NULL, updated_at = NOW()
     WHERE actor_id = $1 AND idempotency_key = $2 AND request_hash = $3
       AND (status <> 'running' OR lease_expires_at IS NULL OR lease_expires_at <= NOW())
     RETURNING actor_id, idempotency_key, request_hash, status, lease_token, lease_expires_at`,
    [actorId, idempotencyKey, requestHash, leaseToken, leaseExpiresAt],
  );
  if (recovered.rows[0] !== undefined)
    return { claimed: true, claim: claimFromRow(recovered.rows[0]) };
  const latest = await selectClaim(pool, actorId, idempotencyKey);
  if (latest === undefined) return claimInvocation(pool, actorId, idempotencyKey, requestHash);
  return { claimed: false, claim: claimFromRow(latest) };
}

async function selectClaim(
  pool: Pool,
  actorId: string,
  idempotencyKey: string,
): Promise<MistralInvocationClaimRow | undefined> {
  const result = await pool.query<MistralInvocationClaimRow>(
    `SELECT actor_id, idempotency_key, request_hash, status, lease_token, lease_expires_at
     FROM provider_invocation_claims
     WHERE actor_id = $1 AND idempotency_key = $2`,
    [actorId, idempotencyKey],
  );
  return result.rows[0];
}

function claimFromRow(row: MistralInvocationClaimRow): MistralInvocationClaim {
  return {
    actorId: row.actor_id,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    status: row.status,
    ...(row.lease_token === null ? {} : { leaseToken: row.lease_token }),
    ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: row.lease_expires_at.getTime() }),
  };
}

function requiredLeaseToken(claim: MistralInvocationClaim): string {
  if (claim.leaseToken === undefined)
    throw new Error('provider invocation claim has no lease token');
  return claim.leaseToken;
}

async function waitForInvocationReplay(
  pool: Pool,
  actorId: string,
  idempotencyKey: string,
  requestHash: string,
  claim: MistralInvocationClaim,
): Promise<CapabilityResult | undefined> {
  const deadline = Math.max(Date.now() + MISTRAL_INVOCATION_LEASE_MS, claim.leaseExpiresAt ?? 0);
  for (;;) {
    const existing = await findInvocation(pool, actorId, idempotencyKey);
    if (existing !== undefined) return ensureMatchingInvocation(existing, requestHash);
    const current = await selectClaim(pool, actorId, idempotencyKey);
    if (current === undefined) return undefined;
    const currentClaim = claimFromRow(current);
    if (currentClaim.requestHash !== requestHash)
      throw new MistralProviderError(
        'IDEMPOTENCY_CONFLICT',
        'idempotencyKey was already used for different Mistral input',
      );
    if (currentClaim.status !== 'running' || (currentClaim.leaseExpiresAt ?? 0) <= Date.now())
      return undefined;
    if (Date.now() >= deadline) return undefined;
    await new Promise<void>((resolve) => setTimeout(resolve, MISTRAL_INVOCATION_POLL_MS));
  }
}

async function persistInvocationAndCompleteClaim(
  pool: Pool,
  actorId: string,
  result: CapabilityResult,
  leaseToken: string,
): Promise<CapabilityResult> {
  const stored = await persistInvocation(pool, actorId, result);
  await pool.query(
    `UPDATE provider_invocation_claims
     SET status = 'completed', lease_token = NULL, lease_expires_at = NULL,
         error = NULL, updated_at = NOW()
     WHERE actor_id = $1 AND idempotency_key = $2 AND lease_token = $3`,
    [actorId, result.provenance.idempotencyKey, leaseToken],
  );
  return stored;
}

async function releaseClaim(
  pool: Pool,
  actorId: string,
  idempotencyKey: string,
  requestHash: string,
  leaseToken: string,
): Promise<void> {
  await pool.query(
    `UPDATE provider_invocation_claims
     SET status = 'failed', lease_token = NULL, lease_expires_at = NULL,
         error = $4, updated_at = NOW()
     WHERE actor_id = $1 AND idempotency_key = $2 AND request_hash = $3 AND lease_token = $5`,
    [actorId, idempotencyKey, requestHash, 'remote invocation failed', leaseToken],
  );
}

function claimableLedger(
  ledger: MistralInvocationLedger,
): ClaimableMistralInvocationLedger | undefined {
  return 'runClaimed' in ledger ? (ledger as ClaimableMistralInvocationLedger) : undefined;
}

async function findInvocation(
  client: Pick<Pool, 'query'> | PoolClient,
  actorId: string,
  idempotencyKey: string,
): Promise<CapabilityResult | undefined> {
  const result = await client.query<{ readonly result: CapabilityResult }>(
    'SELECT result FROM provider_invocations WHERE actor_id = $1 AND idempotency_key = $2',
    [actorId, idempotencyKey],
  );
  return result.rows[0]?.result;
}

async function persistInvocation(
  client: Pick<Pool, 'query'> | PoolClient,
  actorId: string,
  result: CapabilityResult,
): Promise<CapabilityResult> {
  const stored = await client.query<{ readonly result: CapabilityResult }>(
    `INSERT INTO provider_invocations
     (actor_id, idempotency_key, provider_id, model_id, request_hash, result)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (actor_id, idempotency_key) DO NOTHING
     RETURNING result`,
    [
      actorId,
      result.provenance.idempotencyKey,
      result.provenance.providerId,
      result.provenance.modelId,
      result.provenance.requestHash,
      JSON.stringify(result),
    ],
  );
  if (stored.rows[0] !== undefined) return stored.rows[0].result;
  const existing = await findInvocation(client, actorId, result.provenance.idempotencyKey);
  if (existing === undefined) throw new Error('provider invocation record was not persisted');
  return ensureMatchingInvocation(existing, result.provenance.requestHash);
}

function mistralCompletionRequestHash(input: MistralCompletionRequest): string {
  const text = JSON.stringify({
    input: {
      model: input.model,
      messages: input.messages,
      ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
      ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
    },
    idempotencyKey: input.idempotencyKey,
  });
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16)}`;
}
