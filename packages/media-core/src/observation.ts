/** Timestamped evidence identifiers for source and composed media. */

export type ObservationPrivacyOrigin = 'user' | 'reference' | 'synthetic';

/**
 * A source presentation sample. PTS plus presentation index is the identity:
 * VFR and reordered streams may legitimately contain duplicate timestamps.
 */
export interface FrameIdentity {
  readonly assetDigest: string;
  readonly streamId: string;
  readonly presentationIndex: number;
  readonly ptsTicks: string;
  readonly timebaseNumerator: number;
  readonly timebaseDenominator: number;
  readonly sourceTimeUs: number;
  readonly durationUs: number;
}

export interface SourceEvidenceIdentity {
  readonly kind: 'source';
  readonly origin: ObservationPrivacyOrigin;
  readonly frame: FrameIdentity;
}

/**
 * Composition identity is intentionally separate from a source sample. A
 * render can change when either the project revision or one dependency changes
 * even when output time remains the same.
 */
export interface CompositionEvidenceIdentity {
  readonly kind: 'composition';
  readonly compositionId: string;
  readonly projectRevision: string;
  readonly outputTimeUs: number;
  readonly rendererVersion: string;
  readonly evaluatorVersion: string;
  readonly dependencyDigests: readonly string[];
}

export interface ObservationFinding {
  readonly id: string;
  readonly kind: 'cut' | 'flash' | 'text' | 'audio' | 'quality' | 'other';
  readonly evidenceFrameIds: readonly string[];
  readonly confidence: 'low' | 'medium' | 'high';
  /** Required: reviewing inputs is not proof a model understood them. */
  readonly uncertainty: string;
}

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const DIGEST = /^[a-f0-9]{64}$/i;
const STREAM_TOKEN = /^[A-Za-z0-9._-]{1,128}$/;
const OPAQUE_TOKEN = /^[A-Za-z0-9._:=/-]{1,256}$/;

/** Exact floor conversion from PTS ticks to durable integer microseconds. */
export function ptsTicksToSourceTimeUs(
  ptsTicks: string,
  timebaseNumerator: number,
  timebaseDenominator: number,
): number {
  if (!/^(0|[1-9][0-9]*)$/.test(ptsTicks))
    throw new RangeError('ptsTicks must be a non-negative integer string');
  assertPositiveSafeInteger(timebaseNumerator, 'timebaseNumerator');
  assertPositiveSafeInteger(timebaseDenominator, 'timebaseDenominator');
  const numerator = BigInt(ptsTicks) * BigInt(timebaseNumerator) * 1_000_000n;
  const value = numerator / BigInt(timebaseDenominator);
  if (value > MAX_SAFE_BIGINT) throw new RangeError('sourceTimeUs exceeds the safe integer range');
  return Number(value);
}

export function assertFrameIdentity(frame: FrameIdentity): void {
  if (!DIGEST.test(frame.assetDigest))
    throw new RangeError('assetDigest must be a SHA-256 hex digest');
  if (!STREAM_TOKEN.test(frame.streamId)) throw new RangeError('streamId must be an opaque token');
  assertNonNegativeSafeInteger(frame.presentationIndex, 'presentationIndex');
  assertNonNegativeSafeInteger(frame.sourceTimeUs, 'sourceTimeUs');
  assertNonNegativeSafeInteger(frame.durationUs, 'durationUs');
  const expected = ptsTicksToSourceTimeUs(
    frame.ptsTicks,
    frame.timebaseNumerator,
    frame.timebaseDenominator,
  );
  if (frame.sourceTimeUs !== expected)
    throw new RangeError(`sourceTimeUs must equal the PTS/timebase value (${expected})`);
}

export function frameIdentityKey(frame: FrameIdentity): string {
  assertFrameIdentity(frame);
  return [
    'source-frame:v1',
    frame.assetDigest.toLowerCase(),
    frame.streamId,
    frame.presentationIndex,
    frame.ptsTicks,
    `${frame.timebaseNumerator}/${frame.timebaseDenominator}`,
  ].join(':');
}

export function createSourceEvidenceIdentity(
  origin: ObservationPrivacyOrigin,
  frame: FrameIdentity,
): SourceEvidenceIdentity {
  assertFrameIdentity(frame);
  return { kind: 'source', origin, frame };
}

export function createCompositionEvidenceIdentity(
  identity: Omit<CompositionEvidenceIdentity, 'kind'>,
): CompositionEvidenceIdentity {
  assertOpaqueToken(identity.compositionId, 'compositionId');
  assertOpaqueToken(identity.projectRevision, 'projectRevision');
  assertOpaqueToken(identity.rendererVersion, 'rendererVersion');
  assertOpaqueToken(identity.evaluatorVersion, 'evaluatorVersion');
  assertNonNegativeSafeInteger(identity.outputTimeUs, 'outputTimeUs');
  for (const digest of identity.dependencyDigests)
    if (!DIGEST.test(digest))
      throw new RangeError('dependencyDigests must contain SHA-256 hex digests');
  return {
    kind: 'composition',
    ...identity,
    dependencyDigests: [...identity.dependencyDigests].sort(),
  };
}

function assertOpaqueToken(value: string, label: string): void {
  if (!OPAQUE_TOKEN.test(value) || value.includes('://'))
    throw new RangeError(`${label} must be an opaque token`);
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new RangeError(`${label} must be a positive safe integer`);
}

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`${label} must be a non-negative safe integer`);
}
