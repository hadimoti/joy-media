import type { Pool } from 'pg';
import {
  createMistralAdapter,
  MISTRAL_PROVIDER_ID,
  MISTRAL_REASONING_MODELS,
  type MistralChatMessage,
} from '@joy-media/adapter-mistral';
import {
  computeProviderApprovalPreflight,
  resolveProviderDecision,
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
  type ProviderFailureUsage,
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

export interface JoyCodeReasoningEvidence {
  readonly evidenceId: string;
  readonly kind: 'selected-clip' | 'attached-asset' | 'timeline-range' | 'project-summary';
  readonly label: string;
  readonly detail: string;
}

export interface JoyCodeReasoningRequest {
  readonly model: string;
  readonly goal: string;
  readonly snapshotDigest: string;
  readonly projectRevision: string;
  readonly idempotencyKey: string;
  readonly privacyMode: 'local-only' | 'ask-before-remote';
  readonly approvedRemoteProcessing?: boolean;
  readonly approvedSpend?: boolean;
  readonly approvalGrant?: ProviderApprovalGrant | undefined;
  readonly evidence: readonly JoyCodeReasoningEvidence[];
  readonly allowedIntentIds: readonly string[];
  readonly maxTokens?: number;
}

export interface JoyCodeReasoningResponse {
  readonly responseVersion: 1;
  readonly requestId: string;
  readonly brief: {
    readonly summary: string;
    readonly rationale: string;
    readonly evidenceReferences: readonly string[];
    readonly caution?: string;
  };
  readonly proposal?: {
    readonly intentId: string;
    readonly summary: string;
    readonly rationale: string;
    readonly evidenceReferences: readonly string[];
  };
  readonly provider: {
    readonly providerId: typeof MISTRAL_PROVIDER_ID;
    readonly modelId: string;
    readonly decisionRef: string;
    readonly briefRef: string;
    readonly requestDigest: string;
    readonly dataLeavesDevice: boolean;
    readonly retentionDisclosure?: string;
    readonly usage?: {
      readonly inputTokens?: number;
      readonly outputTokens?: number;
      readonly budgetReservationId?: string;
    };
  };
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
    let failureUsage: ProviderFailureUsage | undefined;
    try {
      const result = await this.#provider.invoke('llm.complete', request.input, request);
      failureUsage = { actualCost: result.usage?.cost, providerUsageId: result.requestId };
      if (result.status === 'succeeded') {
        const approvedResult = withApprovalProvenance(result, preflight.requestDigest, approval);
        await this.#approvals.recordSucceeded(
          approvalVerification,
          approval.reservation,
          approvedResult.usage?.cost,
        );
        this.#lifecycle.markHealthy(MISTRAL_PROVIDER_ID);
        this.#lifecycle.recordJobEnd(MISTRAL_PROVIDER_ID, true);
        return this.ledger.record(actorId, approvedResult);
      }
      const code = result.diagnostics[0]?.code;
      this.#lifecycle.recordJobEnd(MISTRAL_PROVIDER_ID, false);
      await this.#approvals.recordFailed(
        approvalVerification,
        approval.reservation,
        code ?? 'provider-request-failed',
        failureUsage,
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
        failureUsage,
      );
      throw new MistralProviderError('MISTRAL_UNAVAILABLE', 'Mistral is unavailable.');
    }
  }

  async joyCodeReason(
    actorId: string,
    input: JoyCodeReasoningRequest,
  ): Promise<JoyCodeReasoningResponse> {
    const request = joyCodeCapabilityRequest(input);
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
      return joyCodeResponseFromProviderResult(
        input,
        previous,
        previous.provenance.providerDecisionId ?? 'provider-decision-replay',
        preflight,
      );
    }

    const status = this.#lifecycle.getStatus(MISTRAL_PROVIDER_ID);
    if (status.state === 'unconfigured') {
      await this.#approvals.recordUnavailable(approvalVerification, 'provider-unconfigured');
      throw new MistralProviderError(
        'PROVIDER_UNCONFIGURED',
        'Mistral is not configured on this server.',
      );
    }

    const providerDecision = resolveProviderDecision(request, [this.#provider], {
      allowRemote: true,
      blockedProviders: [],
      blockedCapabilities: [],
      requireLocalFor: [],
    });
    if (providerDecision.status !== 'selected') {
      await this.#approvals.recordUnavailable(
        approvalVerification,
        providerDecision.reason ?? 'provider-not-eligible',
      );
      throw new MistralProviderError(
        'REMOTE_PROCESSING_BLOCKED',
        providerDecision.reason ?? 'Mistral is not eligible for this request.',
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
    let failureUsage: ProviderFailureUsage | undefined;
    try {
      const providerResult = await this.#provider.invoke(
        'llm.complete',
        {
          model: input.model,
          messages: joyCodeReasoningMessages(input),
          ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
          decisionId: providerDecision.decisionId,
          responseFormat: joyCodeResponseFormat(),
        },
        request,
      );
      failureUsage = {
        actualCost: providerResult.usage?.cost,
        providerUsageId: providerResult.requestId,
      };
      if (providerResult.status !== 'succeeded') {
        const code = providerResult.diagnostics[0]?.code;
        this.#lifecycle.recordJobEnd(MISTRAL_PROVIDER_ID, false);
        await this.#approvals.recordFailed(
          approvalVerification,
          approval.reservation,
          code ?? 'provider-request-failed',
          failureUsage,
        );
        throw new MistralProviderError('MISTRAL_REQUEST_FAILED', 'Mistral completion failed.');
      }
      const approvedResult = withApprovalProvenance(
        providerResult,
        preflight.requestDigest,
        approval,
      );
      let response: JoyCodeReasoningResponse;
      try {
        response = joyCodeResponseFromProviderResult(
          input,
          approvedResult,
          providerDecision.decisionId,
          preflight,
        );
      } catch (error) {
        this.#lifecycle.recordJobEnd(MISTRAL_PROVIDER_ID, false);
        this.#lifecycle.markDegraded(
          MISTRAL_PROVIDER_ID,
          'Mistral bounded reasoning response was invalid.',
          false,
        );
        await this.#approvals.recordFailed(
          approvalVerification,
          approval.reservation,
          'invalid-structured-output',
          failureUsage,
        );
        throw error;
      }
      await this.#approvals.recordSucceeded(
        approvalVerification,
        approval.reservation,
        approvedResult.usage?.cost,
      );
      await this.ledger.record(actorId, approvedResult);
      this.#lifecycle.markHealthy(MISTRAL_PROVIDER_ID);
      this.#lifecycle.recordJobEnd(MISTRAL_PROVIDER_ID, true);
      return response;
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
        failureUsage,
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

function joyCodeCapabilityRequest(input: JoyCodeReasoningRequest): CapabilityRequest {
  return {
    requestVersion: 1,
    capability: 'llm.complete',
    input: {
      model: input.model,
      messages: joyCodeReasoningMessages(input),
      ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
    },
    constraints: { executionPreference: ['remote'] as const, modelAllowlist: [input.model] },
    idempotencyKey: input.idempotencyKey,
  };
}

function joyCodeReasoningMessages(input: JoyCodeReasoningRequest): readonly MistralChatMessage[] {
  return [
    {
      role: 'system',
      content:
        'You are JOY Code reasoning. Return JSON only. Stay bounded to the provided evidence. Do not invent tools, commands, URLs, secrets, filesystem paths, or unsupported intents.',
    },
    {
      role: 'user',
      content: JSON.stringify({
        goal: input.goal,
        snapshotDigest: input.snapshotDigest,
        projectRevision: input.projectRevision,
        evidence: input.evidence,
        allowedIntentIds: input.allowedIntentIds,
      }),
    },
  ];
}

function joyCodeResponseFormat(): {
  readonly type: 'json_schema';
  readonly name: string;
  readonly schema: Record<string, unknown>;
  readonly strict: true;
} {
  return {
    type: 'json_schema',
    name: 'joy_code_reasoning',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['brief'],
      properties: {
        brief: {
          type: 'object',
          additionalProperties: false,
          required: ['summary', 'rationale', 'evidenceReferences'],
          properties: {
            summary: { type: 'string' },
            rationale: { type: 'string' },
            evidenceReferences: {
              type: 'array',
              items: { type: 'string' },
            },
            caution: { type: 'string' },
          },
        },
        proposal: {
          type: 'object',
          additionalProperties: false,
          required: ['intentId', 'summary', 'rationale', 'evidenceReferences'],
          properties: {
            intentId: { type: 'string' },
            summary: { type: 'string' },
            rationale: { type: 'string' },
            evidenceReferences: {
              type: 'array',
              items: { type: 'string' },
            },
          },
        },
      },
    },
  };
}

function joyCodeResponseFromProviderResult(
  input: JoyCodeReasoningRequest,
  result: CapabilityResult,
  decisionRef: string,
  preflight: ReturnType<typeof computeProviderApprovalPreflight>,
): JoyCodeReasoningResponse {
  const rawText = result.outputs[0]?.metadata?.text;
  if (typeof rawText !== 'string' || rawText.length === 0) {
    throw new MistralProviderError(
      'MISTRAL_REQUEST_FAILED',
      'Mistral structured output was empty.',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new MistralProviderError(
      'MISTRAL_REQUEST_FAILED',
      'Mistral structured output was not valid JSON.',
    );
  }
  if (!isRecord(parsed)) {
    throw new MistralProviderError(
      'MISTRAL_REQUEST_FAILED',
      'Mistral structured output was not an object.',
    );
  }
  const knownEvidence = new Set(input.evidence.map((item) => item.evidenceId));
  const brief = parseReasoningBrief(parsed.brief, knownEvidence, 'brief');
  const proposal =
    parsed.proposal === undefined
      ? undefined
      : parseReasoningProposal(parsed.proposal, knownEvidence, input.allowedIntentIds, 'proposal');
  return {
    responseVersion: 1,
    requestId: result.requestId,
    brief,
    ...(proposal === undefined ? {} : { proposal }),
    provider: {
      providerId: MISTRAL_PROVIDER_ID,
      modelId: input.model,
      decisionRef,
      briefRef: `reasoning-brief-${result.provenance.idempotencyKey}`,
      requestDigest: preflight.requestDigest,
      dataLeavesDevice: preflight.dataLeavesDevice,
      ...(preflight.retentionDisclosure === undefined
        ? {}
        : { retentionDisclosure: preflight.retentionDisclosure }),
      ...(result.usage === undefined
        ? {}
        : {
            usage: {
              ...(result.usage.inputTokens === undefined
                ? {}
                : { inputTokens: result.usage.inputTokens }),
              ...(result.usage.outputTokens === undefined
                ? {}
                : { outputTokens: result.usage.outputTokens }),
              ...(result.usage.budgetReservationId === undefined
                ? {}
                : { budgetReservationId: result.usage.budgetReservationId }),
            },
          }),
    },
  };
}

function parseReasoningBrief(
  value: unknown,
  knownEvidence: ReadonlySet<string>,
  path: string,
): JoyCodeReasoningResponse['brief'] {
  if (!isRecord(value)) {
    throw new MistralProviderError('MISTRAL_REQUEST_FAILED', `${path} must be an object.`);
  }
  const summary = boundedString(value.summary, `${path}.summary`, 400);
  const rationale = boundedString(value.rationale, `${path}.rationale`, 800);
  const evidenceReferences = parseEvidenceReferences(
    value.evidenceReferences,
    knownEvidence,
    `${path}.evidenceReferences`,
  );
  const caution =
    value.caution === undefined ? undefined : boundedString(value.caution, `${path}.caution`, 400);
  return {
    summary,
    rationale,
    evidenceReferences,
    ...(caution === undefined ? {} : { caution }),
  };
}

function parseReasoningProposal(
  value: unknown,
  knownEvidence: ReadonlySet<string>,
  allowedIntentIds: readonly string[],
  path: string,
): NonNullable<JoyCodeReasoningResponse['proposal']> {
  if (!isRecord(value)) {
    throw new MistralProviderError('MISTRAL_REQUEST_FAILED', `${path} must be an object.`);
  }
  const intentId = boundedString(value.intentId, `${path}.intentId`, 128);
  if (!allowedIntentIds.includes(intentId)) {
    throw new MistralProviderError(
      'MISTRAL_REQUEST_FAILED',
      `${path}.intentId must be in the bounded allowlist.`,
    );
  }
  return {
    intentId,
    summary: boundedString(value.summary, `${path}.summary`, 400),
    rationale: boundedString(value.rationale, `${path}.rationale`, 800),
    evidenceReferences: parseEvidenceReferences(
      value.evidenceReferences,
      knownEvidence,
      `${path}.evidenceReferences`,
    ),
  };
}

function parseEvidenceReferences(
  value: unknown,
  knownEvidence: ReadonlySet<string>,
  path: string,
): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) {
    throw new MistralProviderError(
      'MISTRAL_REQUEST_FAILED',
      `${path} must contain between 1 and 8 evidence references.`,
    );
  }
  const refs = value.map((item) => boundedString(item, path, 128));
  for (const ref of refs) {
    if (!knownEvidence.has(ref)) {
      throw new MistralProviderError(
        'MISTRAL_REQUEST_FAILED',
        'Mistral structured output referenced unknown evidence.',
      );
    }
  }
  return refs;
}

function boundedString(value: unknown, path: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    throw new MistralProviderError(
      'MISTRAL_REQUEST_FAILED',
      `${path} must be a non-empty string of at most ${String(maxLength)} characters.`,
    );
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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
