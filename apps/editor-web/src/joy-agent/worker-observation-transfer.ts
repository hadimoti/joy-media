import { MAX_MULTIMODAL_EVIDENCE_PER_BATCH } from './multimodal-transport.js';
import { MAX_PRIVATE_OBSERVATION_FIRST_RELEASE_BYTES } from './observation-transfer-port-protocol.js';
import type {
  JoyAgentApprovedImageObservationRequest,
  JoyAgentEngineClient,
  JoyAgentObservationReviewLease,
} from './engine-client.js';
import type {
  ObservationReviewHostTransfer,
  ObservationReviewHostTransferGrant,
  ObservationReviewHostTransferRequest,
} from './observation-review-controller.js';
import type {
  ObservationTransferAuthority,
  ObservationTransferEvidenceResolver,
  ObservationTransferServiceResult,
} from './observation-transfer-service.js';

/**
 * Private adapter between the explicit review controller and the Worker-owned
 * BYOK session. This deliberately has no provider configuration, endpoint,
 * transport, or public protocol dependency. The one-time Worker lease is
 * minted while the source run is live and consumed only after the user grants
 * the exact image-only scope.
 */
export interface WorkerObservationReviewTransferOptions {
  readonly engineClient: Pick<JoyAgentEngineClient, 'sendApprovedImageObservation'>;
  readonly evidenceResolver: ObservationTransferEvidenceResolver;
  readonly currentAuthority: () => ObservationTransferAuthority | undefined;
  /** Private Worker-issued lease. It must never be rendered, persisted, or sent through Host RPC. */
  readonly lease: () => JoyAgentObservationReviewLease | undefined;
  /** Updates local evidence accounting only after a verified Worker success. */
  readonly markReviewed: (
    authority: ObservationTransferAuthority,
    manifest: ObservationReviewHostTransferRequest['manifest'],
    evidenceIds: readonly string[],
  ) => boolean;
}

interface ApprovedScope {
  readonly authority: ObservationTransferAuthority;
  readonly range: ObservationReviewHostTransferGrant['range'];
  readonly evidenceIds: readonly string[];
  readonly maxBytes: number;
  readonly expiresAtMs: number;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const REVISION_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/=-]{0,255}$/;

/**
 * Creates one disposable, image-only transfer path. Granting merely captures
 * the already-rendered consent scope; it never resolves media or calls a
 * provider. `send` is the sole path that asks the Worker for bytes.
 */
export function createWorkerObservationReviewTransfer(
  rawOptions: WorkerObservationReviewTransferOptions,
): ObservationReviewHostTransfer {
  const options = normalizeOptions(rawOptions);
  let approved: ApprovedScope | undefined;
  let disposed = false;
  const controllersByRun = new Map<string, Set<AbortController>>();

  const cancel = (runId: string): boolean => {
    if (!isId(runId)) return false;
    const controllers = controllersByRun.get(runId);
    if (controllers === undefined) return false;
    for (const controller of controllers) controller.abort();
    controllersByRun.delete(runId);
    return true;
  };

  return Object.freeze({
    grantUserApprovedConsent(input: ObservationReviewHostTransferGrant): void {
      if (disposed) throw new Error('worker observation review transfer is disposed');
      const scope = normalizeGrant(input, options.currentAuthority());
      if (scope === undefined) throw new Error('invalid worker observation review grant');
      const lease = options.lease();
      if (
        lease === undefined ||
        lease.expiresAtMs < scope.expiresAtMs ||
        lease.expiresAtMs <= Date.now()
      )
        throw new Error('worker observation review lease is unavailable');
      approved = scope;
    },

    async send(
      input: ObservationReviewHostTransferRequest,
    ): Promise<ObservationTransferServiceResult> {
      if (disposed) return failure('cancelled');
      const scope = approved;
      const request = normalizeRequest(input, scope, options.currentAuthority());
      const lease = options.lease();
      if (request === undefined || scope === undefined || lease === undefined)
        return failure('consent-denied');
      if (input.signal.aborted) return failure('cancelled');
      if (lease.expiresAtMs < scope.expiresAtMs || lease.expiresAtMs <= Date.now())
        return failure('consent-denied');

      // Consume the local approval before the resolver is reachable. A retry,
      // replay, or late event must obtain a fresh explicit user grant and a
      // fresh Worker lease.
      approved = undefined;
      const controller = new AbortController();
      const linked = linkAbortSignal(input.signal, controller);
      const controllers = controllersByRun.get(request.authority.run.runId) ?? new Set();
      controllers.add(controller);
      controllersByRun.set(request.authority.run.runId, controllers);
      try {
        const result = await options.engineClient.sendApprovedImageObservation(
          Object.freeze({
            leaseId: lease.leaseId,
            authority: request.authority,
            range: request.range,
            evidenceIds: request.evidenceIds,
            maxBytes: scope.maxBytes,
            expiresAtMs: scope.expiresAtMs,
            prompt: request.prompt,
            evidenceResolver: options.evidenceResolver,
            signal: controller.signal,
          } satisfies JoyAgentApprovedImageObservationRequest),
        );
        if (controller.signal.aborted) return failure('cancelled');
        if (!sameAuthority(options.currentAuthority(), request.authority))
          return failure('consent-denied');
        if (!result.ok) return failure(mapWorkerFailure(result.code));
        if (!sameIds(result.analysis.submittedEvidenceIds, request.evidenceIds))
          return failure('provider-rejected');
        if (!options.markReviewed(request.authority, request.manifest, request.evidenceIds))
          return failure('invalid-request');
        return Object.freeze({
          ok: true,
          requestBytes: result.requestBytes,
          remainingRequests: 0,
          analysis: Object.freeze({
            text: result.analysis.text,
            submittedEvidenceIds: Object.freeze([...request.evidenceIds]),
            reviewedEvidenceIds: Object.freeze([...request.evidenceIds]),
          }),
        });
      } catch {
        return failure(controller.signal.aborted ? 'cancelled' : 'invalid-request');
      } finally {
        linked();
        controllers.delete(controller);
        // Only drop the map entry if it still points at this Set. cancel()
        // removes the whole Set, and a later send for the same runId installs
        // a fresh one that must not be deleted by this stale finally block.
        const runId = request.authority.run.runId;
        if (controllers.size === 0 && controllersByRun.get(runId) === controllers)
          controllersByRun.delete(runId);
      }
    },

    cancel,

    dispose(): void {
      if (disposed) return;
      disposed = true;
      approved = undefined;
      for (const runId of [...controllersByRun.keys()]) cancel(runId);
    },
  });
}

function normalizeOptions(value: unknown): WorkerObservationReviewTransferOptions {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'engineClient',
      'evidenceResolver',
      'currentAuthority',
      'lease',
      'markReviewed',
    ]) ||
    !isRecord(value.engineClient) ||
    typeof value.engineClient.sendApprovedImageObservation !== 'function' ||
    !isRecord(value.evidenceResolver) ||
    typeof value.evidenceResolver.resolve !== 'function' ||
    typeof value.currentAuthority !== 'function' ||
    typeof value.lease !== 'function' ||
    typeof value.markReviewed !== 'function'
  )
    throw new RangeError('worker observation review transfer requires private dependencies');
  return value as unknown as WorkerObservationReviewTransferOptions;
}

function normalizeGrant(
  value: unknown,
  current: ObservationTransferAuthority | undefined,
): ApprovedScope | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'authority',
      'range',
      'evidenceIds',
      'modalities',
      'mediaCapability',
      'maxRequests',
      'maxBytes',
      'expiresAtMs',
    ]) ||
    value.maxRequests !== 1 ||
    !Array.isArray(value.modalities) ||
    value.modalities.length !== 1 ||
    value.modalities[0] !== 'image' ||
    !isAuthority(value.authority) ||
    !sameAuthority(current, value.authority) ||
    !isRange(value.range) ||
    !isIds(value.evidenceIds) ||
    !isRecord(value.mediaCapability) ||
    !hasExactKeys(value.mediaCapability, ['modelId', 'modalities']) ||
    value.mediaCapability.modelId !== value.authority.modelId ||
    !Array.isArray(value.mediaCapability.modalities) ||
    !value.mediaCapability.modalities.includes('image') ||
    !isPositiveBoundedInteger(value.maxBytes, MAX_PRIVATE_OBSERVATION_FIRST_RELEASE_BYTES) ||
    !isFutureTimestamp(value.expiresAtMs)
  )
    return undefined;
  return Object.freeze({
    authority: cloneAuthority(value.authority),
    range: cloneRange(value.range),
    evidenceIds: Object.freeze([...value.evidenceIds]),
    expiresAtMs: value.expiresAtMs,
    maxBytes: value.maxBytes,
  });
}

function normalizeRequest(
  value: unknown,
  approved: ApprovedScope | undefined,
  current: ObservationTransferAuthority | undefined,
):
  | (Pick<
      ObservationReviewHostTransferRequest,
      'authority' | 'range' | 'evidenceIds' | 'prompt' | 'manifest'
    > & { readonly authority: ObservationTransferAuthority })
  | undefined {
  if (
    approved === undefined ||
    !isRecord(value) ||
    !hasExactKeys(value, [
      'authority',
      'range',
      'prompt',
      'evidenceIds',
      'manifest',
      'mediaCapability',
      'signal',
    ]) ||
    !isAuthority(value.authority) ||
    !sameAuthority(value.authority, approved.authority) ||
    !sameAuthority(current, approved.authority) ||
    !isRange(value.range) ||
    !sameRange(value.range, approved.range) ||
    !isIds(value.evidenceIds) ||
    !sameIds(value.evidenceIds, approved.evidenceIds) ||
    typeof value.prompt !== 'string' ||
    value.prompt.length === 0 ||
    new TextEncoder().encode(value.prompt).byteLength > 16 * 1024 ||
    !isManifest(value.manifest, value.authority) ||
    !isRecord(value.mediaCapability) ||
    value.mediaCapability.modelId !== value.authority.modelId ||
    !Array.isArray(value.mediaCapability.modalities) ||
    value.mediaCapability.modalities.length !== 1 ||
    value.mediaCapability.modalities[0] !== 'image' ||
    !isAbortSignal(value.signal)
  )
    return undefined;
  return Object.freeze({
    authority: cloneAuthority(value.authority),
    range: cloneRange(value.range),
    prompt: value.prompt,
    evidenceIds: Object.freeze([...value.evidenceIds]),
    manifest: cloneManifest(value.manifest),
  });
}

function isAuthority(value: unknown): value is ObservationTransferAuthority {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['projectId', 'revision', 'run', 'modelId', 'promptPolicyDigest']) &&
    isId(value.projectId) &&
    isRevisionId(value.revision) &&
    isId(value.modelId) &&
    isId(value.promptPolicyDigest) &&
    isRecord(value.run) &&
    hasExactKeys(value.run, ['runId', 'epoch']) &&
    isId(value.run.runId) &&
    isPositiveBoundedInteger(value.run.epoch, Number.MAX_SAFE_INTEGER)
  );
}

function isRange(value: unknown): value is ObservationReviewHostTransferGrant['range'] {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['domain', 'startUs', 'endUs']) &&
    value.domain === 'source' &&
    isNonNegativeInteger(value.startUs) &&
    isPositiveBoundedInteger(value.endUs, Number.MAX_SAFE_INTEGER) &&
    value.endUs > value.startUs
  );
}

function isIds(value: unknown): value is readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_MULTIMODAL_EVIDENCE_PER_BATCH
  )
    return false;
  const ids = new Set<string>();
  for (const item of value) {
    if (!isId(item) || ids.has(item)) return false;
    ids.add(item);
  }
  return true;
}

function isManifest(
  value: unknown,
  authority: ObservationTransferAuthority,
): value is ObservationReviewHostTransferRequest['manifest'] {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['manifestId', 'scope']) &&
    isId(value.manifestId) &&
    isRecord(value.scope) &&
    hasExactKeys(value.scope, ['runId', 'identity']) &&
    value.scope.runId === authority.run.runId &&
    isRecord(value.scope.identity) &&
    hasExactKeys(value.scope.identity, [
      'projectId',
      'assetDigest',
      'projectRevision',
      'modelId',
      'promptPolicyDigest',
    ]) &&
    value.scope.identity.projectId === authority.projectId &&
    value.scope.identity.projectRevision === authority.revision &&
    value.scope.identity.modelId === authority.modelId &&
    value.scope.identity.promptPolicyDigest === authority.promptPolicyDigest &&
    typeof value.scope.identity.assetDigest === 'string' &&
    /^[a-f0-9]{64}$/i.test(value.scope.identity.assetDigest)
  );
}

function cloneAuthority(value: ObservationTransferAuthority): ObservationTransferAuthority {
  return Object.freeze({ ...value, run: Object.freeze({ ...value.run }) });
}

function cloneRange(
  value: ObservationReviewHostTransferGrant['range'],
): ObservationReviewHostTransferGrant['range'] {
  return Object.freeze({ ...value });
}

function cloneManifest(
  value: ObservationReviewHostTransferRequest['manifest'],
): ObservationReviewHostTransferRequest['manifest'] {
  return Object.freeze({
    manifestId: value.manifestId,
    scope: Object.freeze({
      runId: value.scope.runId,
      identity: Object.freeze({ ...value.scope.identity }),
    }),
  });
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

function sameRange(
  left: ObservationReviewHostTransferGrant['range'],
  right: ObservationReviewHostTransferGrant['range'],
): boolean {
  return (
    left.domain === right.domain && left.startUs === right.startUs && left.endUs === right.endUs
  );
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function mapWorkerFailure(
  value:
    | 'cancelled'
    | 'capability-unavailable'
    | 'consent-denied'
    | 'invalid-request'
    | 'network-failed'
    | 'provider-rejected',
): Extract<ObservationTransferServiceResult, { readonly ok: false }>['code'] {
  if (value === 'cancelled' || value === 'invalid-request' || value === 'network-failed')
    return value;
  return value === 'provider-rejected' ? 'provider-rejected' : 'consent-denied';
}

function failure(
  code: Extract<ObservationTransferServiceResult, { readonly ok: false }>['code'],
): ObservationTransferServiceResult {
  return Object.freeze({ ok: false, code });
}

function linkAbortSignal(signal: AbortSignal, controller: AbortController): () => void {
  const abort = () => controller.abort();
  if (signal.aborted) controller.abort();
  else signal.addEventListener('abort', abort, { once: true });
  return () => signal.removeEventListener('abort', abort);
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    typeof AbortSignal !== 'undefined' &&
    value instanceof AbortSignal &&
    typeof value.aborted === 'boolean'
  );
}

function isFutureTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > Date.now();
}

function isPositiveBoundedInteger(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value) && !value.includes('://');
}

function isRevisionId(value: unknown): value is string {
  return typeof value === 'string' && REVISION_ID.test(value) && !value.includes('://');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}
