export interface ObservationConsent {
  readonly projectId: string;
  readonly runId: string;
  readonly endpointOrigin: string;
  readonly modelId: string;
  readonly evidenceIds: readonly string[];
  readonly modalities: readonly ('image' | 'audio' | 'video' | 'transcript')[];
  readonly maxRequests: number;
  readonly maxBytes: number;
  readonly expiresAtMs: number;
}

export interface ObservationTransferRequest {
  readonly projectId: string;
  readonly runId: string;
  readonly endpointUrl: string;
  readonly modelId: string;
  readonly evidenceIds: readonly string[];
  readonly modalities: readonly ('image' | 'audio' | 'video' | 'transcript')[];
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
        | 'evidence-mismatch'
        | 'modality-mismatch'
        | 'request-budget'
        | 'byte-budget';
    };

const ISSUED = Symbol('joy-observation-consent-issued');
type IssuedObservationConsent = ObservationConsent & { readonly [ISSUED]: true };

interface ActiveConsent {
  readonly consent: IssuedObservationConsent;
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
  nowMs = Date.now(),
): IssuedObservationConsent {
  assertConsent(consent, nowMs);
  return {
    ...consent,
    evidenceIds: [...new Set(consent.evidenceIds)].sort(),
    modalities: [...new Set(consent.modalities)].sort(),
    [ISSUED]: true,
  };
}

export class ObservationConsentRegistry {
  readonly #active = new Map<string, ActiveConsent>();

  grant(consent: IssuedObservationConsent): void {
    if (consent[ISSUED] !== true)
      throw new Error('observation consent must be issued by the local host');
    this.#active.set(consent.runId, { consent, usedRequests: 0, usedBytes: 0 });
  }

  cancel(runId: string): void {
    this.#active.delete(runId);
  }

  authorize(request: ObservationTransferRequest, nowMs = Date.now()): ObservationAuthorization {
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
    if (!isExactHttpsOrigin(request.endpointUrl, consent.endpointOrigin))
      return { allowed: false, reason: 'endpoint-mismatch' };
    if (!request.evidenceIds.every((id) => consent.evidenceIds.includes(id)))
      return { allowed: false, reason: 'evidence-mismatch' };
    if (!request.modalities.every((modality) => consent.modalities.includes(modality)))
      return { allowed: false, reason: 'modality-mismatch' };
    if (
      !Number.isSafeInteger(request.bytes) ||
      request.bytes < 0 ||
      active.usedBytes + request.bytes > consent.maxBytes
    )
      return { allowed: false, reason: 'byte-budget' };
    if (active.usedRequests >= consent.maxRequests)
      return { allowed: false, reason: 'request-budget' };
    active.usedRequests += 1;
    active.usedBytes += request.bytes;
    return { allowed: true, remainingRequests: consent.maxRequests - active.usedRequests };
  }
}

function assertConsent(consent: ObservationConsent, nowMs: number): void {
  assertId(consent.projectId, 'projectId');
  assertId(consent.runId, 'runId');
  assertId(consent.modelId, 'modelId');
  if (!isExactHttpsOrigin(consent.endpointOrigin, consent.endpointOrigin))
    throw new RangeError('endpointOrigin must be an HTTPS origin without a path');
  if (!Number.isSafeInteger(consent.maxRequests) || consent.maxRequests < 1)
    throw new RangeError('maxRequests must be a positive safe integer');
  if (!Number.isSafeInteger(consent.maxBytes) || consent.maxBytes < 1)
    throw new RangeError('maxBytes must be a positive safe integer');
  if (!Number.isSafeInteger(consent.expiresAtMs) || consent.expiresAtMs <= nowMs)
    throw new RangeError('expiresAtMs must be a future safe integer timestamp');
  if (consent.evidenceIds.length === 0 || consent.evidenceIds.some((id) => !isId(id)))
    throw new RangeError('evidenceIds must be non-empty bounded opaque identifiers');
  if (consent.modalities.length === 0) throw new RangeError('modalities must not be empty');
}

function isExactHttpsOrigin(endpointUrl: string, expectedOrigin: string): boolean {
  try {
    const endpoint = new URL(endpointUrl);
    const expected = new URL(expectedOrigin);
    return (
      endpoint.protocol === 'https:' &&
      expected.protocol === 'https:' &&
      expected.pathname === '/' &&
      !expected.search &&
      !expected.hash &&
      endpoint.origin === expected.origin
    );
  } catch {
    return false;
  }
}

function assertId(value: string, label: string): void {
  if (!isId(value)) throw new RangeError(`${label} must be a bounded opaque identifier`);
}

function isId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(value) && !value.includes('://');
}
