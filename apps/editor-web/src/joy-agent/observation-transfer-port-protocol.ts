import {
  MAX_MULTIMODAL_ANALYSIS_TEXT_BYTES,
  MAX_MULTIMODAL_BATCH_EVIDENCE_BYTES,
  MAX_MULTIMODAL_EVIDENCE_BYTES,
  MAX_MULTIMODAL_EVIDENCE_PER_BATCH,
  MAX_MULTIMODAL_PROMPT_BYTES,
  MAX_MULTIMODAL_REQUEST_BYTES,
} from './multimodal-transport.js';

/**
 * Private, in-memory MessagePort protocol for an explicitly approved image
 * review. This is intentionally not part of the public Worker protocol and
 * must never be tunneled through Host RPC. The only packet that can carry raw
 * media is `evidence`; it is accepted only on the dedicated MessagePort.
 */
export const JOY_PRIVATE_OBSERVATION_PORT_BIND_TYPE =
  'joy-private-observation-port-bind-v1' as const;
export const JOY_PRIVATE_OBSERVATION_PORT_VERSION = 1 as const;
export const MAX_PRIVATE_OBSERVATION_LEASE_MS = 5 * 60 * 1_000;
/**
 * First-release ceiling for human-approved local image review. The generic
 * multimodal transport has a wider internal ceiling, but a private Worker
 * request may never exceed this user-facing scope.
 */
export const MAX_PRIVATE_OBSERVATION_FIRST_RELEASE_BYTES = 20 * 1024 * 1024;

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const SIMPLE_IMAGE_MIME_TYPE = /^image\/[a-z0-9][a-z0-9!#$&^_.+-]{0,127}$/;
// Control characters and bidi overrides are matched deliberately to reject
// provider-shaped or spoofed strings.
// eslint-disable-next-line no-control-regex
const UNSAFE_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;
// The UI must reject provider-shaped strings even if a compromised or stale
// Worker bypasses its own output sanitizer. Keep this aligned with the
// Worker-side guard, without accepting endpoints, credentials, media URLs, or
// raw transport diagnostics through the private port.
const UNSAFE_ANALYSIS =
  /(?:\b(?:https?|file|data|blob):|\\|\b(?:api[_-]?key|authorization|bearer|cookie|headers?)\b)/i;
const TEXT_ENCODER = new TextEncoder();

export interface PrivateObservationAuthority {
  readonly projectId: string;
  readonly revision: string;
  readonly run: {
    readonly runId: string;
    readonly epoch: number;
  };
  readonly modelId: string;
  readonly promptPolicyDigest: string;
}

export interface PrivateObservationRange {
  readonly domain: 'source' | 'composition';
  readonly startUs: number;
  readonly endUs: number;
}

export interface PrivateObservationEvidence {
  readonly evidenceId: string;
  readonly mimeType: string;
  /** Transferred only over this private MessagePort; never React/Host RPC/public Worker data. */
  readonly data: ArrayBuffer;
}

export type PrivateObservationFailureCode =
  | 'cancelled'
  | 'capability-unavailable'
  | 'consent-denied'
  | 'invalid-request'
  | 'network-failed'
  | 'provider-rejected';

export type PrivateObservationTransferResult =
  | {
      readonly ok: true;
      readonly requestBytes: number;
      readonly analysis: {
        readonly text: string;
        readonly submittedEvidenceIds: readonly string[];
      };
    }
  | { readonly ok: false; readonly code: PrivateObservationFailureCode };

/** Keyless control message sent with a transferred MessagePort exactly once per Worker generation. */
export interface PrivateObservationPortBind {
  readonly type: typeof JOY_PRIVATE_OBSERVATION_PORT_BIND_TYPE;
  readonly version: typeof JOY_PRIVATE_OBSERVATION_PORT_VERSION;
  readonly clientGeneration: number;
}

export type PrivateObservationMainToWorkerMessage =
  | {
      readonly type: 'register-review-lease';
      readonly requestId: string;
      readonly sessionEpoch: number;
      readonly authority: PrivateObservationAuthority;
      readonly manifestId: string;
      readonly range: PrivateObservationRange;
      readonly evidenceIds: readonly string[];
      readonly expiresAtMs: number;
    }
  | {
      readonly type: 'start';
      readonly transferId: string;
      readonly sessionEpoch: number;
      readonly leaseId: string;
      readonly authority: PrivateObservationAuthority;
      readonly range: PrivateObservationRange;
      readonly evidenceIds: readonly string[];
      readonly maxBytes: number;
      readonly expiresAtMs: number;
      /** Private prompt text; it is never included in a public event or result. */
      readonly prompt: string;
    }
  | {
      readonly type: 'evidence';
      readonly transferId: string;
      readonly sessionEpoch: number;
      readonly evidence: readonly PrivateObservationEvidence[];
    }
  | {
      readonly type: 'cancel';
      readonly transferId: string;
      readonly sessionEpoch: number;
    };

export type PrivateObservationWorkerToMainMessage =
  | {
      readonly type: 'session-ready';
      readonly sessionEpoch: number;
    }
  | {
      readonly type: 'lease-registered';
      readonly requestId: string;
      readonly leaseId: string;
      readonly sessionEpoch: number;
      readonly expiresAtMs: number;
    }
  | {
      /** Fixed redacted rejection; never carries provider/session diagnostics. */
      readonly type: 'lease-rejected';
      readonly requestId: string;
      readonly sessionEpoch: number;
    }
  | {
      readonly type: 'need-evidence';
      readonly transferId: string;
      readonly sessionEpoch: number;
      readonly authority: PrivateObservationAuthority;
      readonly range: PrivateObservationRange;
      readonly evidenceIds: readonly string[];
      readonly maxBytes: number;
    }
  | {
      readonly type: 'result';
      readonly transferId: string;
      readonly sessionEpoch: number;
      readonly result: PrivateObservationTransferResult;
    };

export function createPrivateObservationPortBind(
  clientGeneration: number,
): PrivateObservationPortBind {
  if (!isPositiveSafeInteger(clientGeneration))
    throw new RangeError('invalid private port generation');
  return Object.freeze({
    type: JOY_PRIVATE_OBSERVATION_PORT_BIND_TYPE,
    version: JOY_PRIVATE_OBSERVATION_PORT_VERSION,
    clientGeneration,
  });
}

export function isPrivateObservationPortBind(value: unknown): value is PrivateObservationPortBind {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['type', 'version', 'clientGeneration']) &&
    value.type === JOY_PRIVATE_OBSERVATION_PORT_BIND_TYPE &&
    value.version === JOY_PRIVATE_OBSERVATION_PORT_VERSION &&
    isPositiveSafeInteger(value.clientGeneration)
  );
}

export function isPrivateObservationMainToWorkerMessage(
  value: unknown,
): value is PrivateObservationMainToWorkerMessage {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  if (value.type === 'register-review-lease') {
    return (
      hasExactKeys(value, [
        'type',
        'requestId',
        'sessionEpoch',
        'authority',
        'manifestId',
        'range',
        'evidenceIds',
        'expiresAtMs',
      ]) &&
      isOpaqueId(value.requestId) &&
      isPositiveSafeInteger(value.sessionEpoch) &&
      isPrivateObservationAuthority(value.authority) &&
      isOpaqueId(value.manifestId) &&
      isPrivateObservationRange(value.range) &&
      isEvidenceIds(value.evidenceIds) &&
      isFutureSafeTimestamp(value.expiresAtMs)
    );
  }
  if (value.type === 'start') {
    return (
      hasExactKeys(value, [
        'type',
        'transferId',
        'sessionEpoch',
        'leaseId',
        'authority',
        'range',
        'evidenceIds',
        'maxBytes',
        'expiresAtMs',
        'prompt',
      ]) &&
      isOpaqueId(value.transferId) &&
      isPositiveSafeInteger(value.sessionEpoch) &&
      isOpaqueId(value.leaseId) &&
      isPrivateObservationAuthority(value.authority) &&
      isPrivateObservationRange(value.range) &&
      isEvidenceIds(value.evidenceIds) &&
      isBoundedBytes(value.maxBytes) &&
      isFutureSafeTimestamp(value.expiresAtMs) &&
      isBoundedPrompt(value.prompt)
    );
  }
  if (value.type === 'evidence') {
    return (
      hasExactKeys(value, ['type', 'transferId', 'sessionEpoch', 'evidence']) &&
      isOpaqueId(value.transferId) &&
      isPositiveSafeInteger(value.sessionEpoch) &&
      isPrivateObservationEvidence(value.evidence)
    );
  }
  return (
    value.type === 'cancel' &&
    hasExactKeys(value, ['type', 'transferId', 'sessionEpoch']) &&
    isOpaqueId(value.transferId) &&
    isPositiveSafeInteger(value.sessionEpoch)
  );
}

export function isPrivateObservationWorkerToMainMessage(
  value: unknown,
): value is PrivateObservationWorkerToMainMessage {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  if (value.type === 'session-ready')
    return (
      hasExactKeys(value, ['type', 'sessionEpoch']) && isPositiveSafeInteger(value.sessionEpoch)
    );
  if (value.type === 'lease-registered') {
    return (
      hasExactKeys(value, ['type', 'requestId', 'leaseId', 'sessionEpoch', 'expiresAtMs']) &&
      isOpaqueId(value.requestId) &&
      isOpaqueId(value.leaseId) &&
      isPositiveSafeInteger(value.sessionEpoch) &&
      isFutureSafeTimestamp(value.expiresAtMs)
    );
  }
  if (value.type === 'lease-rejected') {
    return (
      hasExactKeys(value, ['type', 'requestId', 'sessionEpoch']) &&
      isOpaqueId(value.requestId) &&
      isPositiveSafeInteger(value.sessionEpoch)
    );
  }
  if (value.type === 'need-evidence') {
    return (
      hasExactKeys(value, [
        'type',
        'transferId',
        'sessionEpoch',
        'authority',
        'range',
        'evidenceIds',
        'maxBytes',
      ]) &&
      isOpaqueId(value.transferId) &&
      isPositiveSafeInteger(value.sessionEpoch) &&
      isPrivateObservationAuthority(value.authority) &&
      isPrivateObservationRange(value.range) &&
      isEvidenceIds(value.evidenceIds) &&
      isBoundedBytes(value.maxBytes)
    );
  }
  return (
    value.type === 'result' &&
    hasExactKeys(value, ['type', 'transferId', 'sessionEpoch', 'result']) &&
    isOpaqueId(value.transferId) &&
    isPositiveSafeInteger(value.sessionEpoch) &&
    isPrivateObservationTransferResult(value.result)
  );
}

export function isPrivateObservationAuthority(
  value: unknown,
): value is PrivateObservationAuthority {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['projectId', 'revision', 'run', 'modelId', 'promptPolicyDigest']) ||
    !isOpaqueId(value.projectId) ||
    !isBoundedPlainText(value.revision, 256) ||
    !isBoundedPlainText(value.modelId, 256) ||
    !isBoundedPlainText(value.promptPolicyDigest, 256) ||
    !isRecord(value.run) ||
    !hasExactKeys(value.run, ['runId', 'epoch'])
  )
    return false;
  return isOpaqueId(value.run.runId) && isPositiveSafeInteger(value.run.epoch);
}

export function isPrivateObservationRange(value: unknown): value is PrivateObservationRange {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['domain', 'startUs', 'endUs']) &&
    (value.domain === 'source' || value.domain === 'composition') &&
    isNonNegativeSafeInteger(value.startUs) &&
    isPositiveSafeInteger(value.endUs) &&
    value.endUs > value.startUs &&
    value.endUs - value.startUs <= 6 * 60 * 60 * 1_000_000
  );
}

export function isPrivateObservationTransferResult(
  value: unknown,
): value is PrivateObservationTransferResult {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return false;
  if (value.ok === false)
    return (
      hasExactKeys(value, ['ok', 'code']) &&
      (value.code === 'cancelled' ||
        value.code === 'capability-unavailable' ||
        value.code === 'consent-denied' ||
        value.code === 'invalid-request' ||
        value.code === 'network-failed' ||
        value.code === 'provider-rejected')
    );
  if (
    !hasExactKeys(value, ['ok', 'requestBytes', 'analysis']) ||
    !isPositiveSafeInteger(value.requestBytes)
  )
    return false;
  if (value.requestBytes > MAX_MULTIMODAL_REQUEST_BYTES || !isRecord(value.analysis)) return false;
  return (
    hasExactKeys(value.analysis, ['text', 'submittedEvidenceIds']) &&
    isBoundedAnalysis(value.analysis.text) &&
    isEvidenceIds(value.analysis.submittedEvidenceIds)
  );
}

function isPrivateObservationEvidence(
  value: unknown,
): value is readonly PrivateObservationEvidence[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_MULTIMODAL_EVIDENCE_PER_BATCH
  )
    return false;
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const item of value) {
    if (
      !isRecord(item) ||
      !hasExactKeys(item, ['evidenceId', 'mimeType', 'data']) ||
      !isOpaqueId(item.evidenceId) ||
      seen.has(item.evidenceId) ||
      typeof item.mimeType !== 'string' ||
      !SIMPLE_IMAGE_MIME_TYPE.test(item.mimeType) ||
      !(item.data instanceof ArrayBuffer) ||
      item.data.byteLength === 0 ||
      item.data.byteLength > MAX_MULTIMODAL_EVIDENCE_BYTES
    )
      return false;
    totalBytes += item.data.byteLength;
    if (totalBytes > MAX_MULTIMODAL_BATCH_EVIDENCE_BYTES) return false;
    seen.add(item.evidenceId);
  }
  return true;
}

function isEvidenceIds(value: unknown): value is readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_MULTIMODAL_EVIDENCE_PER_BATCH
  )
    return false;
  const seen = new Set<string>();
  for (const id of value) {
    if (!isOpaqueId(id) || seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}

function isBoundedPrompt(value: unknown): value is string {
  return (
    isBoundedPlainText(value, MAX_MULTIMODAL_PROMPT_BYTES) &&
    TEXT_ENCODER.encode(value).byteLength <= MAX_MULTIMODAL_PROMPT_BYTES
  );
}

function isBoundedAnalysis(value: unknown): value is string {
  return (
    isBoundedPlainText(value, MAX_MULTIMODAL_ANALYSIS_TEXT_BYTES) &&
    TEXT_ENCODER.encode(value).byteLength <= MAX_MULTIMODAL_ANALYSIS_TEXT_BYTES &&
    !UNSAFE_ANALYSIS.test(value)
  );
}

function isBoundedPlainText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    !UNSAFE_TEXT.test(value)
  );
}

function isBoundedBytes(value: unknown): value is number {
  return isPositiveSafeInteger(value) && value <= MAX_MULTIMODAL_REQUEST_BYTES;
}

function isFutureSafeTimestamp(value: unknown): value is number {
  return isPositiveSafeInteger(value) && value <= Number.MAX_SAFE_INTEGER;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_ID.test(value) && !value.includes('://');
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
