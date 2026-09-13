import type { EvidenceManifestLookup, EvidenceStore } from '../media-observation/evidence-store.js';
import type { ByokSessionConfig } from './protocol.js';
import {
  MAX_MULTIMODAL_BATCH_EVIDENCE_BYTES,
  MAX_MULTIMODAL_EVIDENCE_BYTES,
  MAX_MULTIMODAL_EVIDENCE_PER_BATCH,
  MAX_MULTIMODAL_PROMPT_BYTES,
  type MultimodalTransport,
  type MultimodalTransportResult,
  type ObservationEvidencePayload,
} from './multimodal-transport.js';
import {
  MAX_OBSERVATION_CONSENT_RANGE_US,
  OBSERVATION_MODALITIES,
  type ObservationMediaCapability,
  type ObservationModality,
  type ObservationRange,
} from './observation-consent.js';

/**
 * Host-only, in-memory O5 transfer boundary.
 *
 * This service deliberately has no Worker message, persistence, or UI wiring.
 * A mounted UI host must explicitly mint and grant the opaque consent object
 * after a user approves the exact scope. Until that integration exists, this
 * module does not claim that a model has visually reviewed local media.
 */

export interface ObservationTransferAuthority {
  readonly projectId: string;
  readonly revision: string;
  readonly run: {
    readonly runId: string;
    readonly epoch: number;
  };
  readonly modelId: string;
  readonly promptPolicyDigest: string;
}

/**
 * The resolver receives only already-authorized opaque frame/evidence IDs.
 * It never receives a provider URL, API key, full consent object, or prompt.
 */
export interface ObservationTransferEvidenceResolverRequest {
  readonly authority: ObservationTransferAuthority;
  readonly range: ObservationRange;
  readonly evidenceIds: readonly string[];
  readonly allowedModalities: readonly ObservationModality[];
  readonly signal: AbortSignal;
}

export interface ObservationTransferEvidenceResolver {
  resolve(
    input: ObservationTransferEvidenceResolverRequest,
  ):
    | readonly ObservationEvidencePayload[]
    | undefined
    | Promise<readonly ObservationEvidencePayload[] | undefined>;
}

/** Caller-provided grant; `consent` must be the opaque host-minted object. */
export interface ObservationTransferConsentGrant {
  readonly consent: unknown;
  readonly authority: ObservationTransferAuthority;
}

/**
 * No raw bytes, provider URL, request body, or provider credential appears in
 * this request's public result. `manifest` binds temporal evidence tracking to
 * the exact project/revision/model/policy/run scope.
 */
export interface ObservationTransferServiceRequest {
  readonly connection: ByokSessionConfig;
  readonly authority: ObservationTransferAuthority;
  readonly range: ObservationRange;
  readonly prompt: string;
  readonly evidenceIds: readonly string[];
  readonly manifest: EvidenceManifestLookup;
  readonly mediaCapability: ObservationMediaCapability;
  readonly signal?: AbortSignal;
}

export interface ObservationTransferModelAnalysis {
  /** Sanitized bounded text from the direct transport only. */
  readonly text: string;
  /** Opaque evidence IDs sent to the provider after local verification. */
  readonly submittedEvidenceIds: readonly string[];
  /** Same IDs whose successful response was tied to `reviewed` evidence. */
  readonly reviewedEvidenceIds: readonly string[];
}

export type ObservationTransferServiceResult =
  | {
      readonly ok: true;
      readonly requestBytes: number;
      readonly remainingRequests: number;
      readonly analysis: ObservationTransferModelAnalysis;
    }
  | {
      readonly ok: false;
      /** Deliberately generic; it never includes raw payload or provider details. */
      readonly code:
        'consent-denied' | 'invalid-request' | 'cancelled' | 'network-failed' | 'provider-rejected';
    };

export interface ObservationTransferServiceOptions {
  /** Owns direct fetch, provider-key handling, and opaque consent verification. */
  readonly transport: Pick<MultimodalTransport, 'grant' | 'cancel' | 'send' | 'dispose'>;
  /** Receives submitted/reviewed temporal IDs only after a provider response. */
  readonly evidenceStore: Pick<EvidenceStore, 'recordFrames'>;
  readonly evidenceResolver: ObservationTransferEvidenceResolver;
  /** Returns the live host scope at every local media and tracking boundary. */
  readonly currentAuthority: () => ObservationTransferAuthority | undefined;
}

export interface ObservationTransferService {
  /**
   * The UI host calls this only after an explicit user approval. There is no
   * automatic or model-triggered grant path.
   */
  grantUserApprovedConsent(input: ObservationTransferConsentGrant): void;
  /** Revokes the run before aborting both resolver and provider work. */
  cancel(runId: string): boolean;
  /** Performs one bounded, consent-scoped direct transfer. */
  send(input: unknown): Promise<ObservationTransferServiceResult>;
  /** Permanently aborts all work and makes later sends fail closed. */
  dispose(): void;
}

interface ActiveScope {
  readonly authority: ObservationTransferAuthority;
  readonly evidenceIds: ReadonlySet<string>;
  readonly modalities: ReadonlySet<ObservationModality>;
  readonly range: ObservationRange;
  readonly expiresAtMs: number;
}

interface ParsedServiceRequest {
  readonly connection: ByokSessionConfig;
  readonly authority: ObservationTransferAuthority;
  readonly range: ObservationRange;
  readonly prompt: string;
  readonly evidenceIds: readonly string[];
  readonly manifest: EvidenceManifestLookup;
  readonly mediaCapability: ObservationMediaCapability;
  readonly signal: AbortSignal | undefined;
}

interface ParsedConsentScope {
  readonly projectId: string;
  readonly runId: string;
  readonly modelId: string;
  readonly range: ObservationRange;
  readonly evidenceIds: readonly string[];
  readonly modalities: readonly ObservationModality[];
  readonly expiresAtMs: number;
}

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const REVISION_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/=-]{0,255}$/;
const FRAME_ID = /^[A-Za-z0-9][A-Za-z0-9._:@=-]{0,511}$/;
const SHA_256 = /^[a-f0-9]{64}$/i;
const SIMPLE_MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,127}$/;
const UNSAFE_LOCATION = /(?:\b(?:https?|file|data|blob):|\b[A-Za-z]:|(?:^|\/)\.{1,2}(?:\/|$)|\\)/i;
const TEXT_ENCODER = new TextEncoder();

/**
 * Compose the opaque-consent transport with host-only authority, payload, and
 * evidence-store fences. This is intentionally not a Worker bridge: callers
 * must be trusted UI-host code that owns both the consent and local resolver.
 */
export function createObservationTransferService(
  rawOptions: ObservationTransferServiceOptions,
): ObservationTransferService {
  const options = normalizeOptions(rawOptions);
  const activeScopes = new Map<string, ActiveScope>();
  const controllersByRun = new Map<string, Set<AbortController>>();
  let disposed = false;

  const addController = (runId: string, controller: AbortController): void => {
    const controllers = controllersByRun.get(runId) ?? new Set<AbortController>();
    controllers.add(controller);
    controllersByRun.set(runId, controllers);
  };

  const removeController = (runId: string, controller: AbortController): void => {
    const controllers = controllersByRun.get(runId);
    if (controllers === undefined) return;
    controllers.delete(controller);
    if (controllers.size === 0) controllersByRun.delete(runId);
  };

  const isAuthorityCurrent = (authority: ObservationTransferAuthority): boolean => {
    try {
      const current = parseAuthority(options.currentAuthority());
      return current !== undefined && sameAuthority(current, authority);
    } catch {
      return false;
    }
  };

  const isScopeActive = (authority: ObservationTransferAuthority): ActiveScope | undefined => {
    const scope = activeScopes.get(authority.run.runId);
    if (scope === undefined || !sameAuthority(scope.authority, authority)) return undefined;
    if (Date.now() < scope.expiresAtMs) return scope;
    activeScopes.delete(authority.run.runId);
    try {
      options.transport.cancel(authority.run.runId);
    } catch {
      // The scope was still removed; no later resolver/provider use is allowed.
    }
    return undefined;
  };

  return {
    grantUserApprovedConsent(rawGrant: ObservationTransferConsentGrant): void {
      if (disposed) throw new Error('observation transfer service is disposed');
      const grant = parseGrant(rawGrant);
      if (grant === undefined || !isAuthorityCurrent(grant.authority))
        throw new Error('observation consent authority is stale');
      if (
        grant.consent.projectId !== grant.authority.projectId ||
        grant.consent.runId !== grant.authority.run.runId ||
        grant.consent.modelId !== grant.authority.modelId
      ) {
        throw new Error('observation consent scope does not match the active host authority');
      }

      const existing = activeScopes.get(grant.authority.run.runId);
      if (existing !== undefined && !sameAuthority(existing.authority, grant.authority))
        throw new Error('active observation consent cannot replace a different host authority');

      // This verifies the object was minted in-process by issueObservationConsent.
      options.transport.grant(rawGrant.consent);
      activeScopes.set(
        grant.authority.run.runId,
        Object.freeze({
          authority: cloneAuthority(grant.authority),
          evidenceIds: new Set(grant.consent.evidenceIds),
          modalities: new Set(grant.consent.modalities),
          range: cloneRange(grant.consent.range),
          expiresAtMs: grant.consent.expiresAtMs,
        }),
      );
    },

    cancel(runId: string): boolean {
      if (!isOpaqueId(runId)) return false;
      const scopeRemoved = activeScopes.delete(runId);
      const controllers = controllersByRun.get(runId);
      if (controllers !== undefined) {
        for (const controller of controllers) controller.abort();
      }
      let transportCancelled = false;
      try {
        transportCancelled = options.transport.cancel(runId);
      } catch {
        // Local scope and resolver work were already revoked above.
      }
      return scopeRemoved || transportCancelled || controllers !== undefined;
    },

    async send(rawRequest: unknown): Promise<ObservationTransferServiceResult> {
      if (disposed) return failure('cancelled');
      const request = parseRequest(rawRequest);
      if (request === undefined) return failure('invalid-request');
      if (request.signal?.aborted === true) return failure('cancelled');
      const scope = isScopeActive(request.authority);
      if (
        scope === undefined ||
        !isAuthorityCurrent(request.authority) ||
        !sameManifestAuthority(request.manifest, request.authority) ||
        !isRangeWithin(request.range, scope.range) ||
        !request.evidenceIds.every((id) => scope.evidenceIds.has(id))
      ) {
        return failure('consent-denied');
      }

      const controller = new AbortController();
      let unlinkAbort: (() => void) | undefined;
      try {
        unlinkAbort = linkAbortSignal(request.signal, controller);
      } catch {
        return failure('invalid-request');
      }
      addController(request.authority.run.runId, controller);

      try {
        if (controller.signal.aborted) return failure('cancelled');
        const resolved = await options.evidenceResolver.resolve(
          Object.freeze({
            authority: cloneAuthority(request.authority),
            range: cloneRange(request.range),
            evidenceIds: Object.freeze([...request.evidenceIds]),
            allowedModalities: Object.freeze([...scope.modalities]),
            signal: controller.signal,
          }),
        );
        if (controller.signal.aborted) return failure('cancelled');
        if (!isAuthorityCurrent(request.authority) || isScopeActive(request.authority) !== scope) {
          return failure('consent-denied');
        }
        const evidence = normalizeResolvedEvidence(resolved, request, scope);
        if (evidence === undefined) return failure('invalid-request');

        const result = await options.transport.send({
          connection: request.connection,
          projectId: request.authority.projectId,
          runId: request.authority.run.runId,
          range: cloneRange(request.range),
          prompt: request.prompt,
          evidence,
          mediaCapability: request.mediaCapability,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return failure('cancelled');
        if (!isAuthorityCurrent(request.authority) || isScopeActive(request.authority) !== scope) {
          return failure('consent-denied');
        }
        return finalizeProviderResult(options.evidenceStore, request, evidence, result);
      } catch {
        return failure(controller.signal.aborted ? 'cancelled' : 'invalid-request');
      } finally {
        unlinkAbort?.();
        removeController(request.authority.run.runId, controller);
      }
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      activeScopes.clear();
      for (const controllers of controllersByRun.values()) {
        for (const controller of controllers) controller.abort();
      }
      controllersByRun.clear();
      options.transport.dispose();
    },
  };
}

function finalizeProviderResult(
  evidenceStore: Pick<EvidenceStore, 'recordFrames'>,
  request: ParsedServiceRequest,
  evidence: readonly ObservationEvidencePayload[],
  result: MultimodalTransportResult,
): ObservationTransferServiceResult {
  if (result.ok) {
    if (
      containsUnsafeReturnedAnalysis(result.analysis.text, request.connection.baseUrl, evidence)
    ) {
      void recordEvidenceStage(evidenceStore, request.manifest, 'submitted', request.evidenceIds);
      return failure('provider-rejected');
    }
    if (!recordEvidenceStage(evidenceStore, request.manifest, 'submitted', request.evidenceIds))
      return failure('invalid-request');
    if (!recordEvidenceStage(evidenceStore, request.manifest, 'reviewed', request.evidenceIds))
      return failure('invalid-request');
    const reviewedEvidenceIds = Object.freeze([...request.evidenceIds]);
    return Object.freeze({
      ok: true,
      requestBytes: result.requestBytes,
      remainingRequests: result.remainingRequests,
      analysis: Object.freeze({
        text: result.analysis.text,
        submittedEvidenceIds: reviewedEvidenceIds,
        reviewedEvidenceIds,
      }),
    });
  }

  // A received provider error still proves that this bounded batch was
  // submitted, but it never counts as reviewed. Network failures and user
  // cancellation make no claim about delivery.
  if (result.code === 'provider-rejected')
    void recordEvidenceStage(evidenceStore, request.manifest, 'submitted', request.evidenceIds);
  return failure(result.code);
}

/**
 * A model analysis may describe media, but must not turn into a channel for a
 * provider endpoint or an exact text payload to cross back into application
 * state. The payload bytes stay local; only this boolean leaves the check.
 */
function containsUnsafeReturnedAnalysis(
  analysis: string,
  baseUrl: string,
  evidence: readonly ObservationEvidencePayload[],
): boolean {
  if (UNSAFE_LOCATION.test(analysis)) return true;
  try {
    const provider = new URL(baseUrl);
    if (analysis.includes(provider.origin) || analysis.includes(provider.host)) return true;
  } catch {
    return true;
  }
  return evidence.some((payload) => {
    const text = decodePayloadText(payload.data);
    return text !== undefined && text.length >= 8 && analysis.includes(text);
  });
}

function decodePayloadText(bytes: Uint8Array): string | undefined {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // Control characters are rejected deliberately in decoded payload text.
    // eslint-disable-next-line no-control-regex
    return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text) ? undefined : text;
  } catch {
    return undefined;
  }
}

function recordEvidenceStage(
  evidenceStore: Pick<EvidenceStore, 'recordFrames'>,
  manifest: EvidenceManifestLookup,
  stage: 'submitted' | 'reviewed',
  evidenceIds: readonly string[],
): boolean {
  try {
    return evidenceStore.recordFrames({
      manifestId: manifest.manifestId,
      scope: cloneManifestScope(manifest).scope,
      stage,
      frameIds: [...evidenceIds],
    });
  } catch {
    return false;
  }
}

function normalizeOptions(
  value: ObservationTransferServiceOptions,
): ObservationTransferServiceOptions {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ['transport', 'evidenceStore', 'evidenceResolver', 'currentAuthority']) ||
    !isPlainRecord(value.transport) ||
    typeof value.transport.grant !== 'function' ||
    typeof value.transport.cancel !== 'function' ||
    typeof value.transport.send !== 'function' ||
    typeof value.transport.dispose !== 'function' ||
    !isPlainRecord(value.evidenceStore) ||
    typeof value.evidenceStore.recordFrames !== 'function' ||
    !isPlainRecord(value.evidenceResolver) ||
    typeof value.evidenceResolver.resolve !== 'function' ||
    typeof value.currentAuthority !== 'function'
  ) {
    throw new RangeError('observation transfer service requires host-only dependencies');
  }
  return value;
}

function parseGrant(
  value: unknown,
):
  | { readonly consent: ParsedConsentScope; readonly authority: ObservationTransferAuthority }
  | undefined {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['consent', 'authority'])) return undefined;
  const consent = parseConsentScope(value.consent);
  const authority = parseAuthority(value.authority);
  return consent === undefined || authority === undefined ? undefined : { consent, authority };
}

function parseRequest(value: unknown): ParsedServiceRequest | undefined {
  if (
    !isPlainRecord(value) ||
    !hasRequiredAndOptionalKeys(
      value,
      ['connection', 'authority', 'range', 'prompt', 'evidenceIds', 'manifest', 'mediaCapability'],
      ['signal'],
    )
  ) {
    return undefined;
  }
  const connection = parseConnection(value.connection);
  const authority = parseAuthority(value.authority);
  const range = parseRange(value.range);
  const evidenceIds = parseEvidenceIds(value.evidenceIds);
  const manifest = parseManifest(value.manifest);
  const mediaCapability = parseMediaCapability(value.mediaCapability);
  if (
    connection === undefined ||
    authority === undefined ||
    range === undefined ||
    evidenceIds === undefined ||
    manifest === undefined ||
    mediaCapability === undefined ||
    typeof value.prompt !== 'string' ||
    value.prompt.length === 0 ||
    TEXT_ENCODER.encode(value.prompt).byteLength > MAX_MULTIMODAL_PROMPT_BYTES ||
    !isAbortSignalOrUndefined(value.signal) ||
    connection.modelId !== authority.modelId ||
    mediaCapability.modelId !== authority.modelId
  ) {
    return undefined;
  }
  return Object.freeze({
    connection,
    authority,
    range,
    prompt: value.prompt,
    evidenceIds,
    manifest,
    mediaCapability,
    signal: value.signal,
  });
}

function parseConnection(value: unknown): ByokSessionConfig | undefined {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['provider', 'baseUrl', 'modelId', 'apiKey']))
    return undefined;
  if (
    (value.provider !== 'openrouter' && value.provider !== 'openai-compatible') ||
    typeof value.baseUrl !== 'string' ||
    value.baseUrl.length === 0 ||
    value.baseUrl.length > 2_048 ||
    !isOpaqueId(value.modelId) ||
    typeof value.apiKey !== 'string' ||
    value.apiKey.length === 0 ||
    value.apiKey.length > 4_096 ||
    /[\r\n]/.test(value.apiKey)
  ) {
    return undefined;
  }
  return Object.freeze({
    provider: value.provider,
    baseUrl: value.baseUrl,
    modelId: value.modelId,
    apiKey: value.apiKey,
  });
}

function parseAuthority(value: unknown): ObservationTransferAuthority | undefined {
  const candidateRun = isPlainRecord(value) && isPlainRecord(value.run) ? value.run : undefined;
  const epoch = candidateRun?.epoch;
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ['projectId', 'revision', 'run', 'modelId', 'promptPolicyDigest']) ||
    !isOpaqueId(value.projectId) ||
    !isRevisionId(value.revision) ||
    !isOpaqueId(value.modelId) ||
    !isOpaqueId(value.promptPolicyDigest) ||
    candidateRun === undefined ||
    !hasExactKeys(candidateRun, ['runId', 'epoch']) ||
    !isOpaqueId(candidateRun.runId) ||
    !isSafeInteger(epoch) ||
    epoch < 1
  ) {
    return undefined;
  }
  return Object.freeze({
    projectId: value.projectId,
    revision: value.revision,
    run: Object.freeze({ runId: candidateRun.runId, epoch }),
    modelId: value.modelId,
    promptPolicyDigest: value.promptPolicyDigest,
  });
}

function parseConsentScope(value: unknown): ParsedConsentScope | undefined {
  if (!isPlainRecord(value)) return undefined;
  const range = parseRange(value.range);
  const evidenceIds = parseConsentEvidenceIds(value.evidenceIds);
  const modalities = parseModalities(value.modalities);
  const expiresAtMs = value.expiresAtMs;
  if (
    !isOpaqueId(value.projectId) ||
    !isOpaqueId(value.runId) ||
    !isOpaqueId(value.modelId) ||
    range === undefined ||
    evidenceIds === undefined ||
    modalities === undefined ||
    !isSafeInteger(expiresAtMs) ||
    expiresAtMs <= Date.now()
  ) {
    return undefined;
  }
  return Object.freeze({
    projectId: value.projectId,
    runId: value.runId,
    modelId: value.modelId,
    range,
    evidenceIds,
    modalities,
    expiresAtMs,
  });
}

function parseRange(value: unknown): ObservationRange | undefined {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['domain', 'startUs', 'endUs']))
    return undefined;
  const startUs = value.startUs;
  const endUs = value.endUs;
  if (
    (value.domain !== 'source' && value.domain !== 'composition') ||
    !isSafeInteger(startUs) ||
    !isSafeInteger(endUs) ||
    startUs < 0 ||
    endUs <= startUs ||
    endUs - startUs > MAX_OBSERVATION_CONSENT_RANGE_US
  ) {
    return undefined;
  }
  return Object.freeze({ domain: value.domain, startUs, endUs });
}

function parseEvidenceIds(value: unknown): readonly string[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_MULTIMODAL_EVIDENCE_PER_BATCH ||
    value.some((item) => !isFrameId(item))
  ) {
    return undefined;
  }
  const unique = new Set(value);
  return unique.size === value.length ? Object.freeze([...value]) : undefined;
}

function parseConsentEvidenceIds(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => !isOpaqueId(item)))
    return undefined;
  const unique = new Set(value);
  return unique.size === value.length ? Object.freeze([...value]) : undefined;
}

function parseModalities(value: unknown): readonly ObservationModality[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > OBSERVATION_MODALITIES.length ||
    value.some((item) => !isObservationModality(item))
  ) {
    return undefined;
  }
  const unique = new Set(value);
  return unique.size === value.length ? Object.freeze([...value]) : undefined;
}

function parseMediaCapability(value: unknown): ObservationMediaCapability | undefined {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['modelId', 'modalities'])) return undefined;
  const modalities = parseModalities(value.modalities);
  if (!isOpaqueId(value.modelId) || modalities === undefined) return undefined;
  return Object.freeze({ modelId: value.modelId, modalities });
}

function parseManifest(value: unknown): EvidenceManifestLookup | undefined {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['manifestId', 'scope'])) return undefined;
  if (!isFrameId(value.manifestId) || !isPlainRecord(value.scope)) return undefined;
  const scope = value.scope;
  if (
    !hasExactKeys(scope, ['runId', 'identity']) ||
    !isOpaqueId(scope.runId) ||
    !isPlainRecord(scope.identity)
  )
    return undefined;
  const identity = scope.identity;
  if (
    !hasExactKeys(identity, [
      'projectId',
      'assetDigest',
      'projectRevision',
      'modelId',
      'promptPolicyDigest',
    ]) ||
    !isOpaqueId(identity.projectId) ||
    typeof identity.assetDigest !== 'string' ||
    !SHA_256.test(identity.assetDigest) ||
    !isRevisionId(identity.projectRevision) ||
    !isOpaqueId(identity.modelId) ||
    !isOpaqueId(identity.promptPolicyDigest)
  ) {
    return undefined;
  }
  return Object.freeze({
    manifestId: value.manifestId,
    scope: Object.freeze({
      runId: scope.runId,
      identity: Object.freeze({
        projectId: identity.projectId,
        assetDigest: identity.assetDigest.toLowerCase(),
        projectRevision: identity.projectRevision,
        modelId: identity.modelId,
        promptPolicyDigest: identity.promptPolicyDigest,
      }),
    }),
  });
}

function normalizeResolvedEvidence(
  resolved: readonly ObservationEvidencePayload[] | undefined,
  request: ParsedServiceRequest,
  scope: ActiveScope,
): readonly ObservationEvidencePayload[] | undefined {
  if (!Array.isArray(resolved) || resolved.length !== request.evidenceIds.length) return undefined;
  const payloadById = new Map<string, ObservationEvidencePayload>();
  let totalBytes = 0;
  for (const payload of resolved) {
    if (
      !isPlainRecord(payload) ||
      !hasExactKeys(payload, ['evidenceId', 'modality', 'mimeType', 'data'])
    )
      return undefined;
    const normalizedMimeType =
      typeof payload.mimeType === 'string' ? payload.mimeType.toLowerCase() : undefined;
    if (
      !isFrameId(payload.evidenceId) ||
      payloadById.has(payload.evidenceId) ||
      !scope.evidenceIds.has(payload.evidenceId) ||
      !isObservationModality(payload.modality) ||
      !scope.modalities.has(payload.modality) ||
      !request.mediaCapability.modalities.includes(payload.modality) ||
      normalizedMimeType === undefined ||
      !isMimeTypeForModality(normalizedMimeType, payload.modality) ||
      !(payload.data instanceof Uint8Array) ||
      payload.data.byteLength === 0 ||
      payload.data.byteLength > MAX_MULTIMODAL_EVIDENCE_BYTES
    ) {
      return undefined;
    }
    totalBytes += payload.data.byteLength;
    if (totalBytes > MAX_MULTIMODAL_BATCH_EVIDENCE_BYTES) return undefined;
    payloadById.set(
      payload.evidenceId,
      Object.freeze({
        evidenceId: payload.evidenceId,
        modality: payload.modality,
        mimeType: normalizedMimeType,
        // Defend the provider body from a resolver retaining a mutable view.
        data: payload.data.slice(),
      }),
    );
  }
  const ordered = request.evidenceIds.map((id) => payloadById.get(id));
  return ordered.every((payload) => payload !== undefined)
    ? Object.freeze(ordered as ObservationEvidencePayload[])
    : undefined;
}

function sameManifestAuthority(
  manifest: EvidenceManifestLookup,
  authority: ObservationTransferAuthority,
): boolean {
  const { scope } = manifest;
  return (
    scope.runId === authority.run.runId &&
    scope.identity.projectId === authority.projectId &&
    scope.identity.projectRevision === authority.revision &&
    scope.identity.modelId === authority.modelId &&
    scope.identity.promptPolicyDigest === authority.promptPolicyDigest
  );
}

function cloneManifestScope(manifest: EvidenceManifestLookup): EvidenceManifestLookup {
  return Object.freeze({
    manifestId: manifest.manifestId,
    scope: Object.freeze({
      runId: manifest.scope.runId,
      identity: Object.freeze({ ...manifest.scope.identity }),
    }),
  });
}

function sameAuthority(
  left: ObservationTransferAuthority,
  right: ObservationTransferAuthority,
): boolean {
  return (
    left.projectId === right.projectId &&
    left.revision === right.revision &&
    left.run.runId === right.run.runId &&
    left.run.epoch === right.run.epoch &&
    left.modelId === right.modelId &&
    left.promptPolicyDigest === right.promptPolicyDigest
  );
}

function cloneAuthority(authority: ObservationTransferAuthority): ObservationTransferAuthority {
  return Object.freeze({
    projectId: authority.projectId,
    revision: authority.revision,
    run: Object.freeze({ runId: authority.run.runId, epoch: authority.run.epoch }),
    modelId: authority.modelId,
    promptPolicyDigest: authority.promptPolicyDigest,
  });
}

function cloneRange(range: ObservationRange): ObservationRange {
  return Object.freeze({ domain: range.domain, startUs: range.startUs, endUs: range.endUs });
}

function isRangeWithin(request: ObservationRange, consent: ObservationRange): boolean {
  return (
    request.domain === consent.domain &&
    request.startUs >= consent.startUs &&
    request.endUs <= consent.endUs
  );
}

function isMimeTypeForModality(mimeType: string, modality: ObservationModality): boolean {
  if (!SIMPLE_MIME_TYPE.test(mimeType)) return false;
  if (modality === 'image') return mimeType.startsWith('image/');
  if (modality === 'audio') return mimeType.startsWith('audio/');
  if (modality === 'video') return mimeType.startsWith('video/');
  return mimeType === 'text/plain' || mimeType === 'text/markdown';
}

function isObservationModality(value: unknown): value is ObservationModality {
  return typeof value === 'string' && OBSERVATION_MODALITIES.includes(value as ObservationModality);
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_ID.test(value) && !UNSAFE_LOCATION.test(value);
}

function isRevisionId(value: unknown): value is string {
  return typeof value === 'string' && REVISION_ID.test(value) && !UNSAFE_LOCATION.test(value);
}

function isFrameId(value: unknown): value is string {
  return typeof value === 'string' && FRAME_ID.test(value) && !UNSAFE_LOCATION.test(value);
}

function isAbortSignalOrUndefined(value: unknown): value is AbortSignal | undefined {
  if (value === undefined) return true;
  const candidate = value as {
    readonly aborted?: unknown;
    readonly addEventListener?: unknown;
    readonly removeEventListener?: unknown;
  };
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof candidate.aborted === 'boolean' &&
    typeof candidate.addEventListener === 'function' &&
    typeof candidate.removeEventListener === 'function'
  );
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function linkAbortSignal(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (signal === undefined) return () => undefined;
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) controller.abort();
  return () => signal.removeEventListener('abort', abort);
}

function failure(code: Extract<ObservationTransferServiceResult, { readonly ok: false }>['code']) {
  return { ok: false, code } as const;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = [...Object.getOwnPropertyNames(value), ...Object.getOwnPropertySymbols(value)];
  return (
    actual.length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function hasRequiredAndOptionalKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const actual = [...Object.getOwnPropertyNames(value), ...Object.getOwnPropertySymbols(value)];
  return (
    actual.every(
      (key) => typeof key === 'string' && (required.includes(key) || optional.includes(key)),
    ) && required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}
