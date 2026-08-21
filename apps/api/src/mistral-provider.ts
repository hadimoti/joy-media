import type { Pool } from 'pg';
import {
  createMistralAdapter,
  MISTRAL_PROVIDER_ID,
  MISTRAL_REASONING_MODELS,
  type MistralChatMessage,
} from '@joy-media/adapter-mistral';
import {
  computeProviderApprovalPreflight,
  ProviderLifecycle,
  resolveProvider,
  type CapabilityResult,
  type CapabilityRequest,
  type ProviderApprovalGrant,
  type ProviderStatus,
} from '@joy-media/provider-sdk';
import {
  ProviderApprovalError,
  ProviderApprovalService,
  type ProviderApprovalOutcome,
} from './provider-approval.js';

export interface MistralCompletionRequest {
  readonly model: string;
  readonly messages: readonly MistralChatMessage[];
  readonly idempotencyKey: string;
  readonly privacyMode: 'local-only' | 'ask-before-remote';
  readonly approvedRemoteProcessing: boolean;
  readonly approvedSpend: boolean;
  readonly approvalGrant?: ProviderApprovalGrant | undefined;
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

/** Safe fallback for local/dev runs without PostgreSQL. Production uses the Postgres ledger. */
export class MemoryMistralInvocationLedger implements MistralInvocationLedger {
  readonly #records = new Map<string, CapabilityResult>();
  async find(actorId: string, idempotencyKey: string): Promise<CapabilityResult | undefined> {
    return this.#records.get(`${actorId}:${idempotencyKey}`);
  }
  async record(actorId: string, result: CapabilityResult): Promise<CapabilityResult> {
    const key = `${actorId}:${result.provenance.idempotencyKey}`;
    const existing = this.#records.get(key);
    if (existing !== undefined) return existing;
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
  }

  async find(actorId: string, idempotencyKey: string): Promise<CapabilityResult | undefined> {
    const result = await this.pool.query<{ readonly result: CapabilityResult }>(
      'SELECT result FROM provider_invocations WHERE actor_id = $1 AND idempotency_key = $2',
      [actorId, idempotencyKey],
    );
    return result.rows[0]?.result;
  }

  async record(actorId: string, result: CapabilityResult): Promise<CapabilityResult> {
    const stored = await this.pool.query<{ readonly result: CapabilityResult }>(
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
    const existing = await this.find(actorId, result.provenance.idempotencyKey);
    if (existing === undefined) throw new Error('provider invocation record was not persisted');
    return existing;
  }
}

export class MistralProviderRegistry {
  readonly #provider;
  readonly #lifecycle = new ProviderLifecycle();
  readonly #approvals: ProviderApprovalService;

  constructor(
    apiKey: string | undefined,
    private readonly ledger: MistralInvocationLedger = new MemoryMistralInvocationLedger(),
    approvalsOrFetch?: ProviderApprovalService | typeof fetch,
    fetchImpl?: typeof fetch,
  ) {
    const approvals =
      typeof approvalsOrFetch === 'function' || approvalsOrFetch === undefined
        ? new ProviderApprovalService()
        : approvalsOrFetch;
    const resolvedFetch = typeof approvalsOrFetch === 'function' ? approvalsOrFetch : fetchImpl;
    this.#approvals = approvals;
    // An empty value is used only to construct the manifest for the
    // unconfigured state. invoke() is guarded before this adapter can run.
    this.#provider = createMistralAdapter({
      apiKey: apiKey?.trim() ?? '',
      ...(resolvedFetch === undefined ? {} : { fetchImpl: resolvedFetch }),
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
    const request = mistralCapabilityRequest(input);
    const preflight = computeProviderApprovalPreflight(actorId, request, this.#provider);
    const approvalVerification = {
      actorId,
      idempotencyKey: input.idempotencyKey,
      preflight,
      privacyMode: input.privacyMode,
      grant: input.approvalGrant,
      fallbackCostCap: input.approvalGrant?.costCap ?? { amount: '0.00', currency: 'USD' },
    } as const;
    const previous = await this.ledger.find(actorId, input.idempotencyKey);
    if (previous !== undefined) {
      if (previous.provenance.requestHash !== preflight.requestDigest) {
        await this.#approvals.recordFailed(
          approvalVerification,
          undefined,
          'idempotency-request-digest-conflict',
        );
        throw new ProviderApprovalError(
          'PROVIDER_APPROVAL_REPLAY_REJECTED',
          'Idempotent retry does not match the original request digest.',
          preflight,
        );
      }
      await this.#approvals.recordSucceeded(approvalVerification, undefined);
      return previous;
    }

    const status = this.#lifecycle.getStatus(MISTRAL_PROVIDER_ID);
    if (status.state === 'unconfigured') {
      await this.#approvals.recordUnavailable(approvalVerification, 'provider-unconfigured');
      throw new MistralProviderError(
        'PROVIDER_UNCONFIGURED',
        'Mistral is not configured on this server.',
      );
    }

    const resolution = resolveProvider(request, [this.#provider], {
      allowRemote: true,
      blockedProviders: [],
      blockedCapabilities: [],
      requireLocalFor: [],
    });
    if (resolution.status !== 'resolved' || resolution.provider === undefined) {
      await this.#approvals.recordUnavailable(
        approvalVerification,
        resolution.reason ?? 'provider-not-eligible',
      );
      throw new MistralProviderError(
        'REMOTE_PROCESSING_BLOCKED',
        resolution.reason ?? 'Mistral is not eligible for this request.',
      );
    }

    let approval: ProviderApprovalOutcome;
    try {
      approval = await this.#approvals.verify(approvalVerification);
    } catch (error) {
      if (error instanceof ProviderApprovalError) {
        if (error.code === 'REMOTE_PROCESSING_BLOCKED') {
          throw new MistralProviderError('REMOTE_PROCESSING_BLOCKED', error.message);
        }
        if (error.code === 'PROVIDER_APPROVAL_REQUIRED') {
          throw error;
        }
        if (error.code === 'PROVIDER_SPEND_CAP_EXCEEDED') {
          throw new MistralProviderError('PROVIDER_SPEND_APPROVAL_REQUIRED', error.message);
        }
      }
      throw error;
    }

    this.#lifecycle.recordJobStart(MISTRAL_PROVIDER_ID);
    try {
      const result = await this.#provider.invoke('llm.complete', request.input, request);
      if (result.status === 'succeeded') {
        this.#lifecycle.markHealthy(MISTRAL_PROVIDER_ID);
        this.#lifecycle.recordJobEnd(MISTRAL_PROVIDER_ID, true);
        const approvedResult = withApprovalProvenance(result, preflight.requestDigest, approval);
        await this.#approvals.recordSucceeded(
          approvalVerification,
          approval.reservation,
          approvedResult.usage?.cost,
        );
        return this.ledger.record(actorId, approvedResult);
      }
      const code = result.diagnostics[0]?.code;
      this.#lifecycle.recordJobEnd(MISTRAL_PROVIDER_ID, false);
      await this.#approvals.recordFailed(
        approvalVerification,
        approval.reservation,
        code ?? 'provider-request-failed',
      );
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
      if (error instanceof MistralProviderError || error instanceof ProviderApprovalError) {
        throw error;
      }
      this.#lifecycle.recordJobEnd(MISTRAL_PROVIDER_ID, false);
      this.#lifecycle.markDegraded(MISTRAL_PROVIDER_ID, 'Mistral completion failed.', false);
      await this.#approvals.recordFailed(
        approvalVerification,
        approval.reservation,
        'provider-unavailable',
      );
      throw new MistralProviderError('MISTRAL_UNAVAILABLE', 'Mistral is unavailable.');
    }
  }
}

export function createRuntimeMistralProviderRegistry(
  options: {
    readonly apiKey?: string;
    readonly ledger?: MistralInvocationLedger;
    readonly approvals?: ProviderApprovalService;
    readonly fetchImpl?: typeof fetch;
  } = {},
): MistralProviderRegistry {
  return new MistralProviderRegistry(
    options.apiKey,
    options.ledger,
    options.approvals ?? options.fetchImpl,
    options.approvals === undefined ? undefined : options.fetchImpl,
  );
}

function mistralCapabilityRequest(input: MistralCompletionRequest): CapabilityRequest {
  return {
    requestVersion: 1,
    capability: 'llm.complete',
    input: {
      model: input.model,
      messages: input.messages,
      ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
      ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
    },
    constraints: { executionPreference: ['remote'] as const, modelAllowlist: [input.model] },
    idempotencyKey: input.idempotencyKey,
  };
}

function withApprovalProvenance(
  result: CapabilityResult,
  requestDigest: string,
  approval: ProviderApprovalOutcome,
): CapabilityResult {
  return {
    ...result,
    provenance: {
      ...result.provenance,
      requestHash: requestDigest,
      ...(approval.reservation === undefined
        ? {}
        : { budgetReservationId: approval.reservation.reservationId }),
    },
    ...(result.usage === undefined || approval.reservation === undefined
      ? {}
      : {
          usage: {
            ...result.usage,
            budgetReservationId: approval.reservation.reservationId,
          },
        }),
  };
}
