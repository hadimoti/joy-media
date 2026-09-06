import type { EvidenceManifestLookup } from '../media-observation/evidence-store.js';
import {
  MAX_MULTIMODAL_ANALYSIS_TEXT_BYTES,
  MAX_MULTIMODAL_EVIDENCE_PER_BATCH,
  MAX_MULTIMODAL_PROMPT_BYTES,
} from './multimodal-transport.js';
import {
  MAX_OBSERVATION_CONSENT_BYTES,
  MAX_OBSERVATION_CONSENT_RANGE_US,
  MAX_OBSERVATION_CONSENT_REQUESTS,
  OBSERVATION_MODALITIES,
  type ObservationMediaCapability,
  type ObservationModality,
  type ObservationRange,
} from './observation-consent.js';
import type { JoyAgentObservationHostBridge } from './observation-tool-adapter.js';
import type {
  ObservationTransferAuthority,
  ObservationTransferEvidenceResolver,
  ObservationTransferServiceResult,
} from './observation-transfer-service.js';
import {
  PROVIDER_CAPABILITY_STATES,
  type ProviderCapabilityAssessment,
} from './provider-capabilities.js';

/**
 * Main-thread-only review coordinator for a single explicitly approved visual
 * evidence transfer. It intentionally has no Worker transport, no tool-loop
 * callback, and no persistence. The future mounted UI owns all calls into it.
 */
export const OBSERVATION_REVIEW_STATUSES = [
  'idle',
  'consent-required',
  'transferring',
  'reviewed',
  'failed',
  'cancelled',
] as const;

export type ObservationReviewStatus = (typeof OBSERVATION_REVIEW_STATUSES)[number];

export const OBSERVATION_REVIEW_FAILURE_CODES = [
  'invalid-review',
  'provider-unavailable',
  'capability-mismatch',
  'transfer-service-unavailable',
  'consent-invalid',
  'consent-expired',
  'transfer-denied',
  'transfer-invalid',
  'network-failed',
  'provider-rejected',
] as const;

export type ObservationReviewFailureCode = (typeof OBSERVATION_REVIEW_FAILURE_CODES)[number];

export const OBSERVATION_REVIEW_CANCEL_REASONS = [
  'host-cancelled',
  'authority-stale',
  'project-switch',
  'transfer-cancelled',
  'superseded',
  'disposed',
] as const;

export type ObservationReviewCancelReason = (typeof OBSERVATION_REVIEW_CANCEL_REASONS)[number];

/**
 * The exact non-secret binding carried by every public review state. It is
 * deliberately copied rather than exposing a host-owned live object.
 */
export interface ObservationReviewScope {
  readonly projectId: string;
  readonly revision: string;
  readonly run: {
    readonly runId: string;
    readonly epoch: number;
  };
  readonly modelId: string;
  readonly promptPolicyDigest: string;
}

/** Safe-to-render request facts. It never includes a prompt, endpoint, or key. */
export interface ObservationReviewRequestSummary {
  readonly scope: ObservationReviewScope;
  readonly range: ObservationRange;
  readonly evidenceIds: readonly string[];
  readonly modalities: readonly ObservationModality[];
}

/**
 * The only model-produced information retained by this controller. It is
 * bounded plain text plus the opaque evidence identities already approved by
 * the local host. It is presentation data, never tool-loop input.
 */
export interface ObservationReviewAnalysis {
  readonly text: string;
  readonly submittedEvidenceIds: readonly string[];
  readonly reviewedEvidenceIds: readonly string[];
}

export type ObservationReviewState =
  | Readonly<{ readonly status: 'idle' }>
  | Readonly<{
      readonly status: 'consent-required';
      readonly request: ObservationReviewRequestSummary;
    }>
  | Readonly<{
      readonly status: 'transferring';
      readonly request: ObservationReviewRequestSummary;
    }>
  | Readonly<{
      readonly status: 'reviewed';
      readonly request: ObservationReviewRequestSummary;
      readonly analysis: ObservationReviewAnalysis;
    }>
  | Readonly<{
      readonly status: 'failed';
      readonly request?: ObservationReviewRequestSummary;
      readonly code: ObservationReviewFailureCode;
    }>
  | Readonly<{
      readonly status: 'cancelled';
      readonly request?: ObservationReviewRequestSummary;
      readonly reason: ObservationReviewCancelReason;
    }>;

/**
 * Private host input prepared after a bounded source observation has finished.
 * `prompt` is intentionally absent from `ObservationReviewState` and is
 * cleared as soon as the transfer reaches a terminal state.
 */
export interface ObservationReviewPreparation {
  readonly authority: ObservationTransferAuthority;
  readonly manifest: EvidenceManifestLookup;
  readonly range: ObservationRange;
  readonly evidenceIds: readonly string[];
  readonly modalities: readonly ObservationModality[];
  readonly prompt: string;
  /** Redacted factual provider support; no probe transcript belongs here. */
  readonly providerCapability: ProviderCapabilityAssessment;
  /** Redacted model modality support for the exact selected model. */
  readonly mediaCapability: ObservationMediaCapability;
}

/** Only the explicit user-approved limits cross the public grant seam. */
export interface ObservationReviewGrant {
  readonly maxRequests: number;
  readonly maxBytes: number;
  readonly expiresAtMs: number;
}

/**
 * Redacted data supplied to the host-only transfer wrapper at the Allow
 * boundary. The wrapper owns a closure over the volatile provider session and
 * mints the opaque local consent before it calls the real transfer service.
 * No provider-session detail appears here.
 */
export interface ObservationReviewHostTransferGrant {
  readonly authority: ObservationTransferAuthority;
  readonly range: ObservationRange;
  readonly evidenceIds: readonly string[];
  readonly modalities: readonly ObservationModality[];
  readonly mediaCapability: ObservationMediaCapability;
  readonly maxRequests: number;
  readonly maxBytes: number;
  readonly expiresAtMs: number;
}

/** Private transfer request; the human prompt never becomes public state. */
export interface ObservationReviewHostTransferRequest {
  readonly authority: ObservationTransferAuthority;
  readonly range: ObservationRange;
  readonly prompt: string;
  readonly evidenceIds: readonly string[];
  readonly manifest: EvidenceManifestLookup;
  readonly mediaCapability: ObservationMediaCapability;
  readonly signal: AbortSignal;
}

/**
 * Minimal host-only wrapper around ObservationTransferService. A future App
 * integration constructs it in a closure where provider-session selection,
 * consent minting, and the direct provider transport are private. The
 * controller cannot read or return any of those values.
 */
export interface ObservationReviewHostTransfer {
  grantUserApprovedConsent(input: ObservationReviewHostTransferGrant): void;
  send(input: ObservationReviewHostTransferRequest): Promise<ObservationTransferServiceResult>;
  cancel(runId: string): boolean;
  dispose(): void;
}

export interface ObservationReviewHostTransferFactoryInput {
  /** Per-manifest private byte resolver; it is never exposed to Worker tools. */
  readonly evidenceResolver: ObservationTransferEvidenceResolver;
  /** Returns the exact live scope or undefined after terminal/stale state. */
  readonly currentAuthority: () => ObservationTransferAuthority | undefined;
}

export interface ObservationReviewControllerOptions {
  /** Narrow bridge pick deliberately excludes the metadata-only Worker tools. */
  readonly bridge: Pick<JoyAgentObservationHostBridge, 'createEvidenceResolver'>;
  /** Reads the mounted host's exact live project/run/model/policy binding. */
  readonly currentAuthority: () => ObservationTransferAuthority | undefined;
  /** Creates a per-review host-only transfer wrapper with BYOK kept in its closure. */
  readonly createHostTransfer: (
    input: ObservationReviewHostTransferFactoryInput,
  ) => ObservationReviewHostTransfer;
  /** Injectable only for deterministic expiry tests. */
  readonly now?: () => number;
  /** Injectable only for deterministic expiry tests. */
  readonly schedule?: (callback: () => void, delayMs: number) => unknown;
  /** Paired with `schedule`; must cancel only the returned opaque handle. */
  readonly clearScheduled?: (handle: unknown) => void;
}

export interface ObservationReviewController {
  /** A snapshot getter also revokes stale/terminal host authority. */
  getState(): ObservationReviewState;
  /** Future UI can subscribe without gaining any private transfer capability. */
  subscribe(listener: (state: ObservationReviewState) => void): () => void;
  /** Opens a redacted consent-required state. This never sends media. */
  prepareReview(input: ObservationReviewPreparation): ObservationReviewState;
  /**
   * The sole explicit grant path. Its private host wrapper mints opaque
   * consent and starts one direct bounded transfer; no model or Worker can
   * invoke it.
   */
  grantUserApprovedReview(input: ObservationReviewGrant): Promise<ObservationReviewState>;
  /** Revokes local consent and aborts any resolver/provider work for this run. */
  cancel(
    reason?: Extract<ObservationReviewCancelReason, 'host-cancelled' | 'superseded'>,
  ): ObservationReviewState;
  /** Host lifecycle code calls this on project/run/model/policy changes. */
  refresh(): ObservationReviewState;
  /** Permanently aborts a pending transfer and releases private references. */
  dispose(): void;
}

interface NormalizedPreparation {
  readonly authority: ObservationTransferAuthority;
  readonly manifest: EvidenceManifestLookup;
  readonly range: ObservationRange;
  readonly evidenceIds: readonly string[];
  readonly modalities: readonly ObservationModality[];
  readonly prompt: string;
  /** Undefined represents a factually unavailable provider and fails before consent. */
  readonly providerCapability: 'structured-tools' | 'plan-only' | undefined;
  readonly mediaCapability: ObservationMediaCapability;
  readonly summary: ObservationReviewRequestSummary;
}

interface ActiveReview {
  readonly nonce: number;
  readonly preparation: NormalizedPreparation;
  readonly transfer: ObservationReviewHostTransfer;
  controller: AbortController | undefined;
  expiryTimer: { readonly handle: unknown } | undefined;
  expiresAtMs: number | undefined;
}

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const FRAME_ID = /^[A-Za-z0-9][A-Za-z0-9._:@=-]{0,511}$/;
const SHA_256 = /^[a-f0-9]{64}$/i;
const UNSAFE_LOCATION = /(?:\b(?:https?|file|data|blob):|\b[A-Za-z]:|(?:^|\/)\.{1,2}(?:\/|$)|\\)/i;
// Control characters and bidi overrides are matched deliberately to reject
// provider-shaped or spoofed review text.
// eslint-disable-next-line no-control-regex
const UNSAFE_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;
const TEXT_ENCODER = new TextEncoder();

/**
 * Builds the state machine but deliberately does not mount it anywhere. A
 * later App/AgentPanel integration must invoke `refresh()` as its lifecycle
 * changes and render only `getState()` / `subscribe()` snapshots.
 */
export function createObservationReviewController(
  rawOptions: ObservationReviewControllerOptions,
): ObservationReviewController {
  const options = normalizeOptions(rawOptions);
  const listeners = new Set<(state: ObservationReviewState) => void>();
  let state: ObservationReviewState = IDLE_STATE;
  let active: ActiveReview | undefined;
  let nextNonce = 0;
  let disposed = false;

  const notify = (): void => {
    for (const listener of listeners) {
      try {
        listener(state);
      } catch {
        // A display listener cannot keep consent, media, or cancellation alive.
      }
    }
  };

  const setState = (next: ObservationReviewState): ObservationReviewState => {
    state = next;
    notify();
    return state;
  };

  const clearExpiryTimer = (review: ActiveReview): void => {
    if (review.expiryTimer === undefined) return;
    try {
      options.clearScheduled(review.expiryTimer.handle);
    } catch {
      // The consent/review is still revoked below even if a host timer adapter faults.
    }
    review.expiryTimer = undefined;
  };

  const releaseActive = (review: ActiveReview): void => {
    clearExpiryTimer(review);
    review.controller?.abort();
    review.controller = undefined;
    review.expiresAtMs = undefined;
    try {
      review.transfer.cancel(review.preparation.authority.run.runId);
    } catch {
      // Service cancellation is defense in depth; do not leak host exceptions.
    }
    try {
      review.transfer.dispose();
    } catch {
      // Private transfer work still loses all controller references below.
    }
    if (active === review) active = undefined;
  };

  const cancelActive = (reason: ObservationReviewCancelReason): ObservationReviewState => {
    const review = active;
    if (review === undefined) return state;
    const summary = review.preparation.summary;
    releaseActive(review);
    return setState(cancelledState(summary, reason));
  };

  const failActive = (
    code: ObservationReviewFailureCode,
    review = active,
  ): ObservationReviewState => {
    const summary = review?.preparation.summary;
    if (review !== undefined) releaseActive(review);
    return setState(failedState(code, summary));
  };

  const cancellationReasonForAuthority = (
    expected: ObservationTransferAuthority,
    current: ObservationTransferAuthority | undefined,
  ): ObservationReviewCancelReason =>
    current !== undefined && current.projectId !== expected.projectId
      ? 'project-switch'
      : 'authority-stale';

  const reconcile = (): ObservationReviewState => {
    if (active === undefined) return state;
    const current = readCurrentAuthority(options);
    if (!sameAuthority(current, active.preparation.authority)) {
      return cancelActive(cancellationReasonForAuthority(active.preparation.authority, current));
    }
    const now = readNow(options);
    if (active.expiresAtMs !== undefined && (now === undefined || now >= active.expiresAtMs)) {
      return failActive(now === undefined ? 'consent-invalid' : 'consent-expired');
    }
    return state;
  };

  const armExpiry = (review: ActiveReview, expiresAtMs: number): boolean => {
    clearExpiryTimer(review);
    review.expiresAtMs = expiresAtMs;
    const now = readNow(options);
    if (now === undefined) return false;
    try {
      review.expiryTimer = Object.freeze({
        handle: options.schedule(
          () => {
            if (disposed || active !== review || review.nonce !== nextNonce) return;
            const timerNow = readNow(options);
            if (timerNow === undefined) {
              failActive('consent-invalid', review);
            } else if (timerNow >= expiresAtMs) {
              failActive('consent-expired', review);
            }
          },
          Math.max(0, expiresAtMs - now),
        ),
      });
      return true;
    } catch {
      return false;
    }
  };

  const prepareReview = (rawInput: ObservationReviewPreparation): ObservationReviewState => {
    if (disposed) return state;
    reconcile();
    if (active !== undefined) cancelActive('superseded');

    const normalized = normalizePreparation(rawInput);
    if (normalized === undefined) return setState(failedState('invalid-review'));
    if (normalized.providerCapability === undefined)
      return setState(failedState('provider-unavailable', normalized.summary));
    if (!capabilityMatches(normalized.mediaCapability, normalized.authority, normalized.modalities))
      return setState(failedState('capability-mismatch', normalized.summary));
    if (!sameAuthority(readCurrentAuthority(options), normalized.authority))
      return setState(
        cancelledState(
          normalized.summary,
          cancellationReasonForAuthority(normalized.authority, readCurrentAuthority(options)),
        ),
      );

    let transfer: ObservationReviewHostTransfer;
    try {
      const evidenceResolver = options.bridge.createEvidenceResolver(normalized.manifest);
      if (!isEvidenceResolver(evidenceResolver)) throw new Error('unavailable');
      transfer = options.createHostTransfer({
        evidenceResolver,
        currentAuthority: () => {
          const current = readCurrentAuthority(options);
          return sameAuthority(current, normalized.authority) ? current : undefined;
        },
      });
      if (!isHostTransfer(transfer)) throw new Error('unavailable');
    } catch {
      return setState(failedState('transfer-service-unavailable', normalized.summary));
    }

    nextNonce += 1;
    active = {
      nonce: nextNonce,
      preparation: normalized,
      transfer,
      controller: undefined,
      expiryTimer: undefined,
      expiresAtMs: undefined,
    };
    return setState(consentRequiredState(normalized.summary));
  };

  const grantUserApprovedReview = async (
    rawGrant: ObservationReviewGrant,
  ): Promise<ObservationReviewState> => {
    if (disposed) return state;
    reconcile();
    const review = active;
    if (review === undefined || state.status !== 'consent-required') return state;
    const grant = normalizeGrant(rawGrant);
    if (grant === undefined) return failActive('consent-invalid', review);
    if (!sameAuthority(readCurrentAuthority(options), review.preparation.authority)) {
      return cancelActive(
        cancellationReasonForAuthority(review.preparation.authority, readCurrentAuthority(options)),
      );
    }
    if (
      !capabilityMatches(
        review.preparation.mediaCapability,
        review.preparation.authority,
        review.preparation.modalities,
      )
    ) {
      return failActive('capability-mismatch', review);
    }
    const now = readNow(options);
    if (now === undefined) return failActive('consent-invalid', review);
    if (grant.expiresAtMs <= now) return failActive('consent-expired', review);

    try {
      review.transfer.grantUserApprovedConsent({
        authority: review.preparation.authority,
        range: review.preparation.range,
        evidenceIds: review.preparation.evidenceIds,
        modalities: review.preparation.modalities,
        mediaCapability: review.preparation.mediaCapability,
        maxRequests: grant.maxRequests,
        maxBytes: grant.maxBytes,
        expiresAtMs: grant.expiresAtMs,
      });
    } catch {
      return failActive('consent-invalid', review);
    }

    const controller = new AbortController();
    review.controller = controller;
    if (!armExpiry(review, grant.expiresAtMs)) return failActive('consent-invalid', review);
    setState(transferringState(review.preparation.summary));

    let result: ObservationTransferServiceResult;
    try {
      result = await review.transfer.send({
        authority: review.preparation.authority,
        range: review.preparation.range,
        prompt: review.preparation.prompt,
        evidenceIds: review.preparation.evidenceIds,
        manifest: review.preparation.manifest,
        mediaCapability: review.preparation.mediaCapability,
        signal: controller.signal,
      });
    } catch {
      result = { ok: false, code: controller.signal.aborted ? 'cancelled' : 'invalid-request' };
    }

    // A cancellation, expiry, supersession, or authority change may have won
    // while the direct provider work was awaiting. Never resurrect a review.
    if (disposed || active !== review || review.nonce !== nextNonce) return state;
    if (!sameAuthority(readCurrentAuthority(options), review.preparation.authority)) {
      return cancelActive(
        cancellationReasonForAuthority(review.preparation.authority, readCurrentAuthority(options)),
      );
    }
    const completedAt = readNow(options);
    if (completedAt === undefined) return failActive('consent-invalid', review);
    if (completedAt >= grant.expiresAtMs) return failActive('consent-expired', review);

    if (!result.ok) {
      if (result.code === 'cancelled') return cancelActive('transfer-cancelled');
      return failActive(failureCodeForTransfer(result.code), review);
    }

    const analysis = normalizeAnalysis(result, review.preparation.evidenceIds);
    if (analysis === undefined) return failActive('transfer-invalid', review);
    const summary = review.preparation.summary;
    releaseActive(review);
    return setState(reviewedState(summary, analysis));
  };

  return Object.freeze({
    getState(): ObservationReviewState {
      return reconcile();
    },

    subscribe(listener: (next: ObservationReviewState) => void): () => void {
      if (typeof listener !== 'function') return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    prepareReview,
    grantUserApprovedReview,

    cancel(reason = 'host-cancelled'): ObservationReviewState {
      if (disposed) return state;
      if (reason !== 'host-cancelled' && reason !== 'superseded') return state;
      return cancelActive(reason);
    },

    refresh(): ObservationReviewState {
      return reconcile();
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (active !== undefined) cancelActive('disposed');
      listeners.clear();
    },
  });
}

const IDLE_STATE: ObservationReviewState = Object.freeze({ status: 'idle' });

function normalizeOptions(value: ObservationReviewControllerOptions): Required<
  Pick<ObservationReviewControllerOptions, 'bridge' | 'currentAuthority' | 'createHostTransfer'>
> & {
  readonly now: () => number;
  readonly schedule: (callback: () => void, delayMs: number) => unknown;
  readonly clearScheduled: (handle: unknown) => void;
} {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(
      value,
      ['bridge', 'currentAuthority', 'createHostTransfer', 'now', 'schedule', 'clearScheduled'],
      ['bridge', 'currentAuthority', 'createHostTransfer'],
    ) ||
    !isPlainRecord(value.bridge) ||
    typeof value.bridge.createEvidenceResolver !== 'function' ||
    typeof value.currentAuthority !== 'function' ||
    typeof value.createHostTransfer !== 'function' ||
    (value.now !== undefined && typeof value.now !== 'function') ||
    (value.schedule !== undefined && typeof value.schedule !== 'function') ||
    (value.clearScheduled !== undefined && typeof value.clearScheduled !== 'function') ||
    (value.schedule === undefined) !== (value.clearScheduled === undefined)
  ) {
    throw new RangeError('observation review controller requires host-only dependencies');
  }
  return Object.freeze({
    bridge: value.bridge,
    currentAuthority: value.currentAuthority,
    createHostTransfer: value.createHostTransfer,
    now: value.now ?? (() => Date.now()),
    schedule: value.schedule ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs)),
    clearScheduled:
      value.clearScheduled ??
      ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>)),
  });
}

function normalizePreparation(value: unknown): NormalizedPreparation | undefined {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      'authority',
      'manifest',
      'range',
      'evidenceIds',
      'modalities',
      'prompt',
      'providerCapability',
      'mediaCapability',
    ])
  ) {
    return undefined;
  }
  const authority = normalizeAuthority(value.authority);
  const manifest = normalizeManifest(value.manifest);
  const range = normalizeRange(value.range);
  const evidenceIds = normalizeEvidenceIds(value.evidenceIds);
  const modalities = normalizeModalities(value.modalities);
  const mediaCapability = normalizeMediaCapability(value.mediaCapability);
  const providerCapability = normalizeProviderCapability(value.providerCapability);
  if (
    authority === undefined ||
    manifest === undefined ||
    range === undefined ||
    range.domain !== 'source' ||
    evidenceIds === undefined ||
    modalities === undefined ||
    typeof value.prompt !== 'string' ||
    value.prompt.length === 0 ||
    TEXT_ENCODER.encode(value.prompt).byteLength > MAX_MULTIMODAL_PROMPT_BYTES ||
    mediaCapability === undefined ||
    !sameManifestAuthority(manifest, authority)
  ) {
    return undefined;
  }
  const summary = summaryFor(authority, range, evidenceIds, modalities);
  return Object.freeze({
    authority,
    manifest,
    range,
    evidenceIds,
    modalities,
    prompt: value.prompt,
    providerCapability,
    mediaCapability,
    summary,
  });
}

function normalizeGrant(value: unknown): ObservationReviewGrant | undefined {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ['maxRequests', 'maxBytes', 'expiresAtMs']) ||
    !isBoundedPositiveInteger(value.maxRequests, MAX_OBSERVATION_CONSENT_REQUESTS) ||
    !isBoundedPositiveInteger(value.maxBytes, MAX_OBSERVATION_CONSENT_BYTES) ||
    !isTimestamp(value.expiresAtMs)
  ) {
    return undefined;
  }
  return Object.freeze({
    maxRequests: value.maxRequests,
    maxBytes: value.maxBytes,
    expiresAtMs: value.expiresAtMs,
  });
}

function normalizeAuthority(value: unknown): ObservationTransferAuthority | undefined {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ['projectId', 'revision', 'run', 'modelId', 'promptPolicyDigest']) ||
    !isPlainRecord(value.run) ||
    !hasExactKeys(value.run, ['runId', 'epoch']) ||
    !isOpaqueId(value.projectId) ||
    !isOpaqueId(value.revision) ||
    !isOpaqueId(value.run.runId) ||
    !isPositiveSafeInteger(value.run.epoch) ||
    !isOpaqueId(value.modelId) ||
    !isOpaqueId(value.promptPolicyDigest)
  ) {
    return undefined;
  }
  return Object.freeze({
    projectId: value.projectId,
    revision: value.revision,
    run: Object.freeze({ runId: value.run.runId, epoch: value.run.epoch }),
    modelId: value.modelId,
    promptPolicyDigest: value.promptPolicyDigest,
  });
}

function normalizeManifest(value: unknown): EvidenceManifestLookup | undefined {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ['manifestId', 'scope']) ||
    !isFrameId(value.manifestId) ||
    !isPlainRecord(value.scope) ||
    !hasExactKeys(value.scope, ['runId', 'identity']) ||
    !isOpaqueId(value.scope.runId) ||
    !isPlainRecord(value.scope.identity) ||
    !hasExactKeys(value.scope.identity, [
      'projectId',
      'assetDigest',
      'projectRevision',
      'modelId',
      'promptPolicyDigest',
    ]) ||
    !isOpaqueId(value.scope.identity.projectId) ||
    typeof value.scope.identity.assetDigest !== 'string' ||
    !SHA_256.test(value.scope.identity.assetDigest) ||
    !isOpaqueId(value.scope.identity.projectRevision) ||
    !isOpaqueId(value.scope.identity.modelId) ||
    !isOpaqueId(value.scope.identity.promptPolicyDigest)
  ) {
    return undefined;
  }
  return Object.freeze({
    manifestId: value.manifestId,
    scope: Object.freeze({
      runId: value.scope.runId,
      identity: Object.freeze({
        projectId: value.scope.identity.projectId,
        assetDigest: value.scope.identity.assetDigest.toLowerCase(),
        projectRevision: value.scope.identity.projectRevision,
        modelId: value.scope.identity.modelId,
        promptPolicyDigest: value.scope.identity.promptPolicyDigest,
      }),
    }),
  });
}

function normalizeRange(value: unknown): ObservationRange | undefined {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ['domain', 'startUs', 'endUs']) ||
    (value.domain !== 'source' && value.domain !== 'composition') ||
    !isNonNegativeSafeInteger(value.startUs) ||
    !isPositiveSafeInteger(value.endUs) ||
    value.endUs <= value.startUs ||
    value.endUs - value.startUs > MAX_OBSERVATION_CONSENT_RANGE_US
  ) {
    return undefined;
  }
  return Object.freeze({ domain: value.domain, startUs: value.startUs, endUs: value.endUs });
}

function normalizeEvidenceIds(value: unknown): readonly string[] | undefined {
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

function normalizeModalities(value: unknown): readonly ObservationModality[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > OBSERVATION_MODALITIES.length ||
    value.some((item) => !isObservationModality(item))
  ) {
    return undefined;
  }
  const unique = new Set(value);
  return unique.size === value.length
    ? Object.freeze([...value] as ObservationModality[])
    : undefined;
}

function normalizeMediaCapability(value: unknown): ObservationMediaCapability | undefined {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ['modelId', 'modalities']) ||
    !isOpaqueId(value.modelId)
  ) {
    return undefined;
  }
  const modalities = normalizeModalities(value.modalities);
  return modalities === undefined
    ? undefined
    : Object.freeze({ modelId: value.modelId, modalities });
}

function normalizeProviderCapability(value: unknown): 'structured-tools' | 'plan-only' | undefined {
  if (!isPlainRecord(value) || !isProviderCapabilityState(value.state)) return undefined;
  // Direct observation review is a presentation-only path, so a proven
  // plan-only provider remains eligible; an unavailable provider never is.
  return value.state === 'structured-tools' || value.state === 'plan-only'
    ? value.state
    : undefined;
}

function summaryFor(
  authority: ObservationTransferAuthority,
  range: ObservationRange,
  evidenceIds: readonly string[],
  modalities: readonly ObservationModality[],
): ObservationReviewRequestSummary {
  return Object.freeze({
    scope: scopeFor(authority),
    range: Object.freeze({ ...range }),
    evidenceIds: Object.freeze([...evidenceIds]),
    modalities: Object.freeze([...modalities]),
  });
}

function scopeFor(authority: ObservationTransferAuthority): ObservationReviewScope {
  return Object.freeze({
    projectId: authority.projectId,
    revision: authority.revision,
    run: Object.freeze({ runId: authority.run.runId, epoch: authority.run.epoch }),
    modelId: authority.modelId,
    promptPolicyDigest: authority.promptPolicyDigest,
  });
}

function consentRequiredState(request: ObservationReviewRequestSummary): ObservationReviewState {
  return Object.freeze({ status: 'consent-required', request });
}

function transferringState(request: ObservationReviewRequestSummary): ObservationReviewState {
  return Object.freeze({ status: 'transferring', request });
}

function reviewedState(
  request: ObservationReviewRequestSummary,
  analysis: ObservationReviewAnalysis,
): ObservationReviewState {
  return Object.freeze({ status: 'reviewed', request, analysis });
}

function failedState(
  code: ObservationReviewFailureCode,
  request?: ObservationReviewRequestSummary,
): ObservationReviewState {
  return Object.freeze({ status: 'failed', ...(request === undefined ? {} : { request }), code });
}

function cancelledState(
  request: ObservationReviewRequestSummary | undefined,
  reason: ObservationReviewCancelReason,
): ObservationReviewState {
  return Object.freeze({
    status: 'cancelled',
    ...(request === undefined ? {} : { request }),
    reason,
  });
}

function capabilityMatches(
  capability: ObservationMediaCapability,
  authority: ObservationTransferAuthority,
  modalities: readonly ObservationModality[],
): boolean {
  return (
    capability.modelId === authority.modelId &&
    modalities.every((modality) => capability.modalities.includes(modality))
  );
}

function normalizeAnalysis(
  result: Extract<ObservationTransferServiceResult, { readonly ok: true }>,
  expectedEvidenceIds: readonly string[],
): ObservationReviewAnalysis | undefined {
  const rawAnalysis = result.analysis;
  if (!isPlainRecord(rawAnalysis)) return undefined;
  const text = sanitizeAnalysis(rawAnalysis.text);
  const submittedEvidenceIds = normalizeEvidenceIds(rawAnalysis.submittedEvidenceIds);
  const reviewedEvidenceIds = normalizeEvidenceIds(rawAnalysis.reviewedEvidenceIds);
  if (
    text === undefined ||
    submittedEvidenceIds === undefined ||
    reviewedEvidenceIds === undefined ||
    !sameOrderedIds(submittedEvidenceIds, expectedEvidenceIds) ||
    !sameOrderedIds(reviewedEvidenceIds, expectedEvidenceIds)
  ) {
    return undefined;
  }
  return Object.freeze({ text, submittedEvidenceIds, reviewedEvidenceIds });
}

function sanitizeAnalysis(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.normalize('NFC').replace(/\r\n?/g, '\n').trim();
  return text.length > 0 &&
    TEXT_ENCODER.encode(text).byteLength <= MAX_MULTIMODAL_ANALYSIS_TEXT_BYTES &&
    !UNSAFE_TEXT.test(text) &&
    !UNSAFE_LOCATION.test(text)
    ? text
    : undefined;
}

function failureCodeForTransfer(
  code: Extract<ObservationTransferServiceResult, { readonly ok: false }>['code'],
): ObservationReviewFailureCode {
  if (code === 'network-failed') return 'network-failed';
  if (code === 'provider-rejected') return 'provider-rejected';
  if (code === 'consent-denied') return 'transfer-denied';
  return 'transfer-invalid';
}

function readNow(options: ReturnType<typeof normalizeOptions>): number | undefined {
  try {
    const value = options.now();
    return isTimestamp(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function readCurrentAuthority(
  options: ReturnType<typeof normalizeOptions>,
): ObservationTransferAuthority | undefined {
  try {
    return normalizeAuthority(options.currentAuthority());
  } catch {
    return undefined;
  }
}

function sameAuthority(
  left: ObservationTransferAuthority | undefined,
  right: ObservationTransferAuthority,
): boolean {
  return (
    left !== undefined &&
    left.projectId === right.projectId &&
    left.revision === right.revision &&
    left.run.runId === right.run.runId &&
    left.run.epoch === right.run.epoch &&
    left.modelId === right.modelId &&
    left.promptPolicyDigest === right.promptPolicyDigest
  );
}

function sameManifestAuthority(
  manifest: EvidenceManifestLookup,
  authority: ObservationTransferAuthority,
): boolean {
  return (
    manifest.scope.runId === authority.run.runId &&
    manifest.scope.identity.projectId === authority.projectId &&
    manifest.scope.identity.projectRevision === authority.revision &&
    manifest.scope.identity.modelId === authority.modelId &&
    manifest.scope.identity.promptPolicyDigest === authority.promptPolicyDigest
  );
}

function sameOrderedIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isEvidenceResolver(value: unknown): value is ObservationTransferEvidenceResolver {
  return isPlainRecord(value) && typeof value.resolve === 'function';
}

function isHostTransfer(value: unknown): value is ObservationReviewHostTransfer {
  return (
    isPlainRecord(value) &&
    typeof value.grantUserApprovedConsent === 'function' &&
    typeof value.cancel === 'function' &&
    typeof value.send === 'function' &&
    typeof value.dispose === 'function'
  );
}

function isProviderCapabilityState(value: unknown): value is ProviderCapabilityAssessment['state'] {
  return (
    typeof value === 'string' && (PROVIDER_CAPABILITY_STATES as readonly string[]).includes(value)
  );
}

function isObservationModality(value: unknown): value is ObservationModality {
  return typeof value === 'string' && OBSERVATION_MODALITIES.includes(value as ObservationModality);
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_ID.test(value) && !UNSAFE_LOCATION.test(value);
}

function isFrameId(value: unknown): value is string {
  return typeof value === 'string' && FRAME_ID.test(value) && !UNSAFE_LOCATION.test(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isBoundedPositiveInteger(value: unknown, maximum: number): value is number {
  return isPositiveSafeInteger(value) && value <= maximum;
}

function isTimestamp(value: unknown): value is number {
  return isNonNegativeSafeInteger(value);
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

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
): boolean {
  const actual = [...Object.getOwnPropertyNames(value), ...Object.getOwnPropertySymbols(value)];
  return (
    actual.every((key) => typeof key === 'string' && allowed.includes(key)) &&
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}
