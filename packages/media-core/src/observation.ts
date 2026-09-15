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
const OPAQUE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:=-]{0,255}$/;
const FINDING_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@=-]{0,511}$/;
const MAX_PTS_TICKS_DIGITS = 64;
const MAX_COMPOSITION_DEPENDENCY_DIGESTS = 256;
const MAX_FINDING_EVIDENCE_IDS = 256;
const MAX_FINDING_UNCERTAINTY_LENGTH = 512;
const PRIVACY_ORIGINS: readonly ObservationPrivacyOrigin[] = ['user', 'reference', 'synthetic'];
const FINDING_KINDS: readonly ObservationFinding['kind'][] = [
  'cut',
  'flash',
  'text',
  'audio',
  'quality',
  'other',
];
const FINDING_CONFIDENCES: readonly ObservationFinding['confidence'][] = ['low', 'medium', 'high'];
const FRAME_IDENTITY_KEYS = [
  'assetDigest',
  'streamId',
  'presentationIndex',
  'ptsTicks',
  'timebaseNumerator',
  'timebaseDenominator',
  'sourceTimeUs',
  'durationUs',
] as const;
const COMPOSITION_IDENTITY_KEYS = [
  'compositionId',
  'projectRevision',
  'outputTimeUs',
  'rendererVersion',
  'evaluatorVersion',
  'dependencyDigests',
] as const;
const FINDING_KEYS = ['id', 'kind', 'evidenceFrameIds', 'confidence', 'uncertainty'] as const;

/** Exact floor conversion from PTS ticks to durable integer microseconds. */
export function ptsTicksToSourceTimeUs(
  ptsTicks: string,
  timebaseNumerator: number,
  timebaseDenominator: number,
): number {
  if (ptsTicks.length > MAX_PTS_TICKS_DIGITS || !/^(0|[1-9][0-9]*)$/.test(ptsTicks))
    throw new RangeError('ptsTicks must be a non-negative integer string');
  assertPositiveSafeInteger(timebaseNumerator, 'timebaseNumerator');
  assertPositiveSafeInteger(timebaseDenominator, 'timebaseDenominator');
  const numerator = BigInt(ptsTicks) * BigInt(timebaseNumerator) * 1_000_000n;
  const value = numerator / BigInt(timebaseDenominator);
  if (value > MAX_SAFE_BIGINT) throw new RangeError('sourceTimeUs exceeds the safe integer range');
  return Number(value);
}

export function assertFrameIdentity(frame: unknown): asserts frame is FrameIdentity {
  if (!isPlainRecord(frame) || !hasExactKeys(frame, FRAME_IDENTITY_KEYS))
    throw new RangeError('frame identity must contain only bounded evidence fields');
  if (typeof frame.assetDigest !== 'string' || !DIGEST.test(frame.assetDigest))
    throw new RangeError('assetDigest must be a SHA-256 hex digest');
  if (typeof frame.streamId !== 'string' || !STREAM_TOKEN.test(frame.streamId))
    throw new RangeError('streamId must be an opaque token');
  assertNonNegativeSafeInteger(frame.presentationIndex, 'presentationIndex');
  if (typeof frame.ptsTicks !== 'string')
    throw new RangeError('ptsTicks must be a non-negative integer string');
  assertPositiveSafeInteger(frame.timebaseNumerator, 'timebaseNumerator');
  assertPositiveSafeInteger(frame.timebaseDenominator, 'timebaseDenominator');
  assertNonNegativeSafeInteger(frame.sourceTimeUs, 'sourceTimeUs');
  assertNonNegativeSafeInteger(frame.durationUs, 'durationUs');
  if (frame.sourceTimeUs + frame.durationUs > Number.MAX_SAFE_INTEGER)
    throw new RangeError('frame end exceeds the safe integer range');
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
    `timebase-${frame.timebaseNumerator}-${frame.timebaseDenominator}`,
  ].join(':');
}

export function createSourceEvidenceIdentity(
  origin: ObservationPrivacyOrigin,
  frame: FrameIdentity,
): SourceEvidenceIdentity {
  if (!isObservationPrivacyOrigin(origin))
    throw new RangeError('origin must be user, reference, or synthetic');
  assertFrameIdentity(frame);
  return {
    kind: 'source',
    origin,
    frame: {
      assetDigest: frame.assetDigest.toLowerCase(),
      streamId: frame.streamId,
      presentationIndex: frame.presentationIndex,
      ptsTicks: frame.ptsTicks,
      timebaseNumerator: frame.timebaseNumerator,
      timebaseDenominator: frame.timebaseDenominator,
      sourceTimeUs: frame.sourceTimeUs,
      durationUs: frame.durationUs,
    },
  };
}

export function createCompositionEvidenceIdentity(
  identity: Omit<CompositionEvidenceIdentity, 'kind'>,
): CompositionEvidenceIdentity {
  if (!isPlainRecord(identity) || !hasExactKeys(identity, COMPOSITION_IDENTITY_KEYS))
    throw new RangeError('composition identity must contain only bounded evidence fields');
  assertOpaqueToken(identity.compositionId, 'compositionId');
  assertOpaqueToken(identity.projectRevision, 'projectRevision');
  assertOpaqueToken(identity.rendererVersion, 'rendererVersion');
  assertOpaqueToken(identity.evaluatorVersion, 'evaluatorVersion');
  assertNonNegativeSafeInteger(identity.outputTimeUs, 'outputTimeUs');
  if (
    !Array.isArray(identity.dependencyDigests) ||
    identity.dependencyDigests.length > MAX_COMPOSITION_DEPENDENCY_DIGESTS
  )
    throw new RangeError('dependencyDigests must be a bounded page of SHA-256 hex digests');
  for (const digest of identity.dependencyDigests)
    if (typeof digest !== 'string' || !DIGEST.test(digest))
      throw new RangeError('dependencyDigests must contain SHA-256 hex digests');
  return {
    kind: 'composition',
    compositionId: identity.compositionId,
    projectRevision: identity.projectRevision,
    outputTimeUs: identity.outputTimeUs,
    rendererVersion: identity.rendererVersion,
    evaluatorVersion: identity.evaluatorVersion,
    dependencyDigests: identity.dependencyDigests.map((digest) => digest.toLowerCase()).sort(),
  };
}

/** Narrows a value to one of the only privacy origins this evidence may carry. */
export function isObservationPrivacyOrigin(value: unknown): value is ObservationPrivacyOrigin {
  return typeof value === 'string' && (PRIVACY_ORIGINS as readonly string[]).includes(value);
}

/**
 * Validates a bounded, evidence-linked finding. The schema deliberately does
 * not accept raw paths, URLs, or unbounded evidence lists.
 */
export function assertObservationFinding(finding: unknown): asserts finding is ObservationFinding {
  if (!isPlainRecord(finding) || !hasExactKeys(finding, FINDING_KEYS))
    throw new RangeError('finding must contain only bounded evidence fields');
  if (
    typeof finding.id !== 'string' ||
    !FINDING_IDENTIFIER.test(finding.id) ||
    containsUnsafeLocation(finding.id)
  )
    throw new RangeError('finding.id must be a bounded opaque identifier');
  if (
    typeof finding.kind !== 'string' ||
    !(FINDING_KINDS as readonly string[]).includes(finding.kind)
  )
    throw new RangeError('finding.kind must be a supported finding kind');
  if (
    typeof finding.confidence !== 'string' ||
    !(FINDING_CONFIDENCES as readonly string[]).includes(finding.confidence)
  )
    throw new RangeError('finding.confidence must be low, medium, or high');
  if (
    !Array.isArray(finding.evidenceFrameIds) ||
    finding.evidenceFrameIds.length === 0 ||
    finding.evidenceFrameIds.length > MAX_FINDING_EVIDENCE_IDS ||
    !finding.evidenceFrameIds.every(
      (id) => typeof id === 'string' && FINDING_IDENTIFIER.test(id) && !containsUnsafeLocation(id),
    )
  )
    throw new RangeError('finding.evidenceFrameIds must be a bounded page of opaque identifiers');
  if (
    typeof finding.uncertainty !== 'string' ||
    finding.uncertainty.trim().length === 0 ||
    finding.uncertainty.length > MAX_FINDING_UNCERTAINTY_LENGTH ||
    containsUnsafeLocation(finding.uncertainty)
  )
    throw new RangeError('finding.uncertainty must be bounded and contain no raw path or URL');
}

function assertOpaqueToken(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length > 256 ||
    !OPAQUE_TOKEN.test(value) ||
    containsUnsafeLocation(value)
  )
    throw new RangeError(`${label} must be an opaque token`);
}

function assertPositiveSafeInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    throw new RangeError(`${label} must be a positive safe integer`);
}

function assertNonNegativeSafeInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`${label} must be a non-negative safe integer`);
}

function containsUnsafeLocation(value: string): boolean {
  return /(?:\b(?:https?|file|data|blob):|\b[A-Za-z]:|(?:^|\s|=|:|\(|\[)(?:~?\/|\\\\)|(?:^|\/)\.{1,2}(?:\/|$)|\\)/i.test(
    value,
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = [...Object.getOwnPropertyNames(value), ...Object.getOwnPropertySymbols(value)];
  return (
    actual.length === expected.length &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}
