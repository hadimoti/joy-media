export const OBSERVATION_MODALITIES = ['image', 'audio', 'video', 'transcript'] as const;

export type ObservationModality = (typeof OBSERVATION_MODALITIES)[number];

export interface ObservationRange {
  /** Source and composition ranges are never interchangeable. */
  readonly domain: 'source' | 'composition';
  /** Inclusive range start in microseconds. */
  readonly startUs: number;
  /** Exclusive range end in microseconds. */
  readonly endUs: number;
}

/**
 * Redacted result from a future host-owned synthetic/public media capability
 * probe. It is not a consent and cannot contain an endpoint, key, or media.
 */
export interface ObservationMediaCapability {
  readonly modelId: string;
  readonly modalities: readonly ObservationModality[];
}

export interface ObservationConsent {
  readonly projectId: string;
  readonly runId: string;
  readonly endpointOrigin: string;
  readonly modelId: string;
  readonly range: ObservationRange;
  readonly evidenceIds: readonly string[];
  readonly modalities: readonly ObservationModality[];
  readonly maxRequests: number;
  readonly maxBytes: number;
  readonly expiresAtMs: number;
}

export interface ObservationTransferRequest {
  readonly projectId: string;
  readonly runId: string;
  readonly endpointUrl: string;
  readonly modelId: string;
  readonly range: ObservationRange;
  readonly evidenceIds: readonly string[];
  readonly modalities: readonly ObservationModality[];
  readonly bytes: number;
}

export type ObservationAuthorization =
  | { readonly allowed: true; readonly remainingRequests: number }
  | {
      readonly allowed: false;
      readonly reason:
        | 'consent-missing'
        | 'expired'
        | 'project-mismatch'
        | 'endpoint-mismatch'
        | 'model-mismatch'
        | 'range-mismatch'
        | 'evidence-mismatch'
        | 'modality-mismatch'
        | 'request-budget'
        | 'byte-budget'
        | 'invalid-request';
    };

export const MAX_OBSERVATION_CONSENT_EVIDENCE_IDS = 512;
export const MAX_OBSERVATION_CONSENT_REQUESTS = 64;
export const MAX_OBSERVATION_CONSENT_BYTES = 512 * 1024 * 1024;
export const MAX_OBSERVATION_CONSENT_RANGE_US = 6 * 60 * 60 * 1_000_000;
export const MAX_OBSERVATION_CONSENT_TTL_MS = 60 * 60 * 1_000;

const ISSUED = Symbol('joy-observation-consent-issued');
type IssuedObservationConsent = ObservationConsent & { readonly [ISSUED]: true };
const ISSUED_CONSENTS = new WeakSet<IssuedObservationConsent>();
const CLAIMED_CONSENTS = new WeakSet<IssuedObservationConsent>();

interface StoredObservationConsent {
  readonly projectId: string;
  readonly runId: string;
  readonly endpointOrigin: string;
  readonly modelId: string;
  readonly range: ObservationRange;
  readonly evidenceIds: readonly string[];
  readonly modalities: readonly ObservationModality[];
  readonly maxRequests: number;
  readonly maxBytes: number;
  readonly expiresAtMs: number;
}

interface ActiveConsent {
  readonly issued: IssuedObservationConsent;
  readonly consent: StoredObservationConsent;
  usedRequests: number;
  usedBytes: number;
}

/**
 * Only the UI host can create this opaque, in-memory object after a user
 * approves the exact media scope. A provider/model response cannot serialize
 * the private symbol, and the object is intentionally not persisted.
 */
export function issueObservationConsent(
  consent: ObservationConsent,
  mediaCapability: ObservationMediaCapability,
  nowMs = Date.now(),
): IssuedObservationConsent {
  assertConsent(consent, mediaCapability, nowMs);
  const endpointOrigin = canonicalEndpointOrigin(consent.endpointOrigin);
  if (endpointOrigin === undefined)
    throw new RangeError('endpointOrigin must be an HTTPS or localhost origin without a path');
  const range = snapshotRange(consent.range);
  const issued = {
    projectId: consent.projectId,
    runId: consent.runId,
    endpointOrigin,
    modelId: consent.modelId,
    range,
    evidenceIds: Object.freeze([...new Set(consent.evidenceIds)].sort()),
    modalities: Object.freeze(
      [...new Set(consent.modalities)].sort(),
    ) as readonly ObservationModality[],
    maxRequests: consent.maxRequests,
    maxBytes: consent.maxBytes,
    expiresAtMs: consent.expiresAtMs,
  };
  Object.defineProperty(issued, ISSUED, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  const frozen = Object.freeze(issued) as IssuedObservationConsent;
  ISSUED_CONSENTS.add(frozen);
  return frozen;
}

export class ObservationConsentRegistry {
  readonly #active = new Map<string, ActiveConsent>();

  grant(consent: unknown): void {
    if (!isIssuedConsent(consent))
      throw new Error('observation consent must be issued by the local host');
    const active = this.#active.get(consent.runId);
    if (active !== undefined) {
      if (active.issued !== consent)
        throw new Error('active observation consent cannot be replaced without cancellation');
      return;
    }
    if (CLAIMED_CONSENTS.has(consent))
      throw new Error('observation consent cannot be reused after cancellation or completion');
    const snapshot = snapshotConsent(consent);
    CLAIMED_CONSENTS.add(consent);
    this.#active.set(snapshot.runId, {
      issued: consent,
      consent: snapshot,
      usedRequests: 0,
      usedBytes: 0,
    });
  }

  /** Alias retained for UI cancellation; consent is never persisted. */
  cancel(runId: string): boolean {
    return this.revoke(runId);
  }

  /** Explicit revocation prevents queued later batches from using this run. */
  revoke(runId: string): boolean {
    if (!isId(runId)) return false;
    return this.#active.delete(runId);
  }

  authorize(request: unknown, nowMs = Date.now()): ObservationAuthorization {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !isObservationTransferRequest(request))
      return { allowed: false, reason: 'invalid-request' };
    const active = this.#active.get(request.runId);
    if (active === undefined) return { allowed: false, reason: 'consent-missing' };
    const { consent } = active;
    if (nowMs >= consent.expiresAtMs) {
      this.#active.delete(request.runId);
      return { allowed: false, reason: 'expired' };
    }
    if (request.projectId !== consent.projectId)
      return { allowed: false, reason: 'project-mismatch' };
    if (request.modelId !== consent.modelId) return { allowed: false, reason: 'model-mismatch' };
    if (!isEndpointAtOrigin(request.endpointUrl, consent.endpointOrigin))
      return { allowed: false, reason: 'endpoint-mismatch' };
    if (!isRangeWithin(request.range, consent.range))
      return { allowed: false, reason: 'range-mismatch' };
    if (!request.evidenceIds.every((id) => consent.evidenceIds.includes(id)))
      return { allowed: false, reason: 'evidence-mismatch' };
    if (!request.modalities.every((modality) => consent.modalities.includes(modality)))
      return { allowed: false, reason: 'modality-mismatch' };
    if (active.usedBytes + request.bytes > consent.maxBytes)
      return { allowed: false, reason: 'byte-budget' };
    if (active.usedRequests >= consent.maxRequests)
      return { allowed: false, reason: 'request-budget' };
    active.usedRequests += 1;
    active.usedBytes += request.bytes;
    return { allowed: true, remainingRequests: consent.maxRequests - active.usedRequests };
  }
}

function assertConsent(
  consent: ObservationConsent,
  mediaCapability: ObservationMediaCapability,
  nowMs: number,
): void {
  if (!isRecord(consent) || !exactKeys(consent, CONSENT_KEYS))
    throw new RangeError('observation consent must contain only the approved scope fields');
  if (!Number.isSafeInteger(nowMs) || nowMs < 0)
    throw new RangeError('nowMs must be a non-negative safe integer timestamp');
  assertId(consent.projectId, 'projectId');
  assertId(consent.runId, 'runId');
  assertId(consent.modelId, 'modelId');
  if (canonicalEndpointOrigin(consent.endpointOrigin) === undefined)
    throw new RangeError('endpointOrigin must be an HTTPS or localhost origin without a path');
  assertRange(consent.range, 'range');
  if (
    !Array.isArray(consent.evidenceIds) ||
    consent.evidenceIds.length === 0 ||
    consent.evidenceIds.length > MAX_OBSERVATION_CONSENT_EVIDENCE_IDS ||
    consent.evidenceIds.some((id) => !isId(id))
  )
    throw new RangeError('evidenceIds must be non-empty bounded opaque identifiers');
  if (
    !Array.isArray(consent.modalities) ||
    consent.modalities.length === 0 ||
    consent.modalities.length > OBSERVATION_MODALITIES.length ||
    consent.modalities.some((modality) => !isObservationModality(modality))
  )
    throw new RangeError('modalities must contain supported media modalities');
  if (
    !Number.isSafeInteger(consent.maxRequests) ||
    consent.maxRequests < 1 ||
    consent.maxRequests > MAX_OBSERVATION_CONSENT_REQUESTS
  )
    throw new RangeError('maxRequests must be a bounded positive safe integer');
  if (
    !Number.isSafeInteger(consent.maxBytes) ||
    consent.maxBytes < 1 ||
    consent.maxBytes > MAX_OBSERVATION_CONSENT_BYTES
  )
    throw new RangeError('maxBytes must be a bounded positive safe integer');
  if (
    !Number.isSafeInteger(consent.expiresAtMs) ||
    consent.expiresAtMs <= nowMs ||
    consent.expiresAtMs - nowMs > MAX_OBSERVATION_CONSENT_TTL_MS
  )
    throw new RangeError('expiresAtMs must be a bounded future safe integer timestamp');
  assertMediaCapability(mediaCapability, consent.modelId, consent.modalities);
}

function snapshotConsent(consent: ObservationConsent): StoredObservationConsent {
  return Object.freeze({
    projectId: consent.projectId,
    runId: consent.runId,
    endpointOrigin: consent.endpointOrigin,
    modelId: consent.modelId,
    range: snapshotRange(consent.range),
    evidenceIds: Object.freeze([...consent.evidenceIds]),
    modalities: Object.freeze([...consent.modalities]),
    maxRequests: consent.maxRequests,
    maxBytes: consent.maxBytes,
    expiresAtMs: consent.expiresAtMs,
  });
}

function isIssuedConsent(value: unknown): value is IssuedObservationConsent {
  if (!isRecord(value)) return false;
  // The private symbol and WeakSet membership make this an opaque host-issued
  // object; the assertion is only a type bridge after the runtime object check.
  const issued = value as unknown as IssuedObservationConsent;
  return issued[ISSUED] === true && ISSUED_CONSENTS.has(issued);
}

function assertMediaCapability(
  capability: ObservationMediaCapability,
  modelId: string,
  requestedModalities: readonly ObservationModality[],
): void {
  if (!isRecord(capability) || !exactKeys(capability, MEDIA_CAPABILITY_KEYS))
    throw new RangeError('media capability must contain only redacted capability fields');
  assertId(capability.modelId, 'mediaCapability.modelId');
  if (capability.modelId !== modelId)
    throw new RangeError('media capability modelId must exactly match consent modelId');
  if (
    !Array.isArray(capability.modalities) ||
    capability.modalities.length > OBSERVATION_MODALITIES.length ||
    capability.modalities.some((modality) => !isObservationModality(modality))
  )
    throw new RangeError('media capability modalities are invalid');
  if (!requestedModalities.every((modality) => capability.modalities.includes(modality)))
    throw new RangeError('model does not have the requested media capability');
}

function isObservationTransferRequest(value: unknown): value is ObservationTransferRequest {
  if (!isRecord(value) || !exactKeys(value, TRANSFER_REQUEST_KEYS)) return false;
  const { projectId, runId, endpointUrl, modelId, range, evidenceIds, modalities, bytes } = value;
  if (!isId(projectId) || !isId(runId) || !isId(modelId)) return false;
  if (!isEndpointUrl(endpointUrl)) return false;
  if (!isValidRange(range)) return false;
  return (
    Array.isArray(evidenceIds) &&
    evidenceIds.length > 0 &&
    evidenceIds.length <= MAX_OBSERVATION_CONSENT_EVIDENCE_IDS &&
    evidenceIds.every((id) => isId(id)) &&
    Array.isArray(modalities) &&
    modalities.length > 0 &&
    modalities.length <= OBSERVATION_MODALITIES.length &&
    modalities.every((modality) => isObservationModality(modality)) &&
    typeof bytes === 'number' &&
    Number.isSafeInteger(bytes) &&
    bytes > 0 &&
    bytes <= MAX_OBSERVATION_CONSENT_BYTES
  );
}

function canonicalEndpointOrigin(value: unknown): string | undefined {
  try {
    if (typeof value !== 'string' || value.length === 0 || value.length > 2_048) return undefined;
    const endpoint = new URL(value);
    if (
      !isHttpsOrLocalhost(endpoint) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.pathname !== '/' ||
      endpoint.search ||
      endpoint.hash
    )
      return undefined;
    return endpoint.origin;
  } catch {
    return undefined;
  }
}

function isEndpointAtOrigin(endpointUrl: string, expectedOrigin: string): boolean {
  try {
    const endpoint = new URL(endpointUrl);
    return (
      isHttpsOrLocalhost(endpoint) &&
      !endpoint.username &&
      !endpoint.password &&
      !endpoint.search &&
      !endpoint.hash &&
      endpoint.origin === expectedOrigin
    );
  } catch {
    return false;
  }
}

function isEndpointUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return isEndpointAtOrigin(value, new URL(value).origin);
  } catch {
    return false;
  }
}

function isHttpsOrLocalhost(endpoint: URL): boolean {
  return (
    endpoint.protocol === 'https:' ||
    (endpoint.protocol === 'http:' &&
      (endpoint.hostname === 'localhost' ||
        endpoint.hostname === '127.0.0.1' ||
        endpoint.hostname === '[::1]'))
  );
}

function assertRange(value: unknown, label: string): asserts value is ObservationRange {
  if (!isValidRange(value))
    throw new RangeError(`${label} must be a bounded half-open observation range`);
}

function isValidRange(value: unknown): value is ObservationRange {
  if (!isRecord(value) || !exactKeys(value, RANGE_KEYS)) return false;
  const { domain, startUs, endUs } = value;
  return (
    (domain === 'source' || domain === 'composition') &&
    typeof startUs === 'number' &&
    Number.isSafeInteger(startUs) &&
    typeof endUs === 'number' &&
    Number.isSafeInteger(endUs) &&
    startUs >= 0 &&
    endUs > startUs &&
    endUs - startUs <= MAX_OBSERVATION_CONSENT_RANGE_US
  );
}

function snapshotRange(range: ObservationRange): ObservationRange {
  assertRange(range, 'range');
  return Object.freeze({ domain: range.domain, startUs: range.startUs, endUs: range.endUs });
}

function isRangeWithin(request: ObservationRange, consent: ObservationRange): boolean {
  return (
    request.domain === consent.domain &&
    request.startUs >= consent.startUs &&
    request.endUs <= consent.endUs
  );
}

function isObservationModality(value: unknown): value is ObservationModality {
  return typeof value === 'string' && OBSERVATION_MODALITIES.includes(value as ObservationModality);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}

const CONSENT_KEYS = [
  'projectId',
  'runId',
  'endpointOrigin',
  'modelId',
  'range',
  'evidenceIds',
  'modalities',
  'maxRequests',
  'maxBytes',
  'expiresAtMs',
] as const;
const TRANSFER_REQUEST_KEYS = [
  'projectId',
  'runId',
  'endpointUrl',
  'modelId',
  'range',
  'evidenceIds',
  'modalities',
  'bytes',
] as const;
const MEDIA_CAPABILITY_KEYS = ['modelId', 'modalities'] as const;
const RANGE_KEYS = ['domain', 'startUs', 'endUs'] as const;

function assertId(value: unknown, label: string): asserts value is string {
  if (!isId(value)) throw new RangeError(`${label} must be a bounded opaque identifier`);
}

function isId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(value) &&
    !value.includes('://')
  );
}
