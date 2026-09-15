import type {
  FinalEncodedExportCheckKind,
  FinalEncodedExportExpectation,
  FinalEncodedExportVerificationResult,
} from './media-observation/render-verification.js';

/**
 * This receipt schema version intentionally matches the lazily loaded
 * verifier. Keeping it local prevents the export history/UI path from
 * eagerly loading the browser decoder dependency graph.
 */
export const FINAL_EXPORT_VERIFICATION_RECEIPT_VERIFIER_VERSION =
  'joy-final-encoded-export-verifier-v1' as const;

/**
 * Durable, metadata-only proof attached to one export history entry.
 *
 * It deliberately excludes the final Blob, decoded pixels/audio, opaque asset
 * identifiers, browser/Worker errors, and any source-media reference. The
 * entry may therefore survive localStorage reloads without turning process
 * history into another media cache or a diagnostics leak.
 */
export type FinalExportVerificationReceipt =
  | {
      readonly verifierVersion: typeof FINAL_EXPORT_VERIFICATION_RECEIPT_VERIFIER_VERSION;
      readonly decoderVersion: string;
      readonly checkedAt: string;
      readonly status: 'verified';
      readonly scope: 'decoded-final-encoded-export';
      readonly facts: FinalExportVerificationFacts;
      readonly checkKinds: readonly FinalEncodedExportCheckKind[];
    }
  | {
      readonly verifierVersion: typeof FINAL_EXPORT_VERIFICATION_RECEIPT_VERIFIER_VERSION;
      readonly decoderVersion: string;
      readonly checkedAt: string;
      readonly status: 'failed';
      readonly code: FinalExportVerificationFailureCode;
    }
  | {
      readonly verifierVersion: typeof FINAL_EXPORT_VERIFICATION_RECEIPT_VERIFIER_VERSION;
      readonly decoderVersion: string;
      readonly checkedAt: string;
      readonly status: 'unavailable';
      readonly code: FinalExportVerificationUnavailableCode;
    }
  | {
      readonly verifierVersion: typeof FINAL_EXPORT_VERIFICATION_RECEIPT_VERIFIER_VERSION;
      readonly decoderVersion: string;
      readonly checkedAt: string;
      readonly status: 'blocked';
      readonly code: FinalExportVerificationBlockedCode;
    };

export interface FinalExportVerificationFacts {
  readonly container: 'mp4';
  readonly width: number;
  readonly height: number;
  readonly durationUs: number;
  readonly videoStreamCount: number;
  readonly audioStreamCount: number;
  readonly presentationFrameCount: number;
}

export type FinalExportVerificationFailureCode =
  | 'artifact-too-large'
  | 'decoder-failed'
  | 'invalid-decoder-output'
  | 'decoded-pixel-budget-exceeded'
  | 'decoded-audio-budget-exceeded'
  | 'container-mismatch'
  | 'dimensions-mismatch'
  | 'duration-mismatch'
  | 'video-streams-mismatch'
  | 'audio-streams-mismatch'
  | 'video-codec-mismatch'
  | 'audio-codec-mismatch'
  | 'video-pts-incomplete'
  | 'video-pts-mismatch'
  | 'missing-decoded-frame'
  | 'missing-decoded-audio'
  | 'pixel-predicate-failed'
  | 'black-frame-predicate-failed'
  | 'audio-sync-predicate-failed';

export type FinalExportVerificationUnavailableCode =
  'decoder-unavailable' | 'decoder-not-actual' | 'format-unsupported';

export type FinalExportVerificationBlockedCode = 'artifact-not-readable' | 'decoder-policy';

/** Immutable details produced before the browser encode starts. */
export interface FinalExportVerificationManifest {
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
  readonly durationUs: number;
  readonly frameCount: number;
}

const MAX_EXPECTED_PRESENTATION_PTS = 100_000;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const CHECK_KINDS: readonly FinalEncodedExportCheckKind[] = Object.freeze([
  'container',
  'dimensions',
  'duration',
  'video-streams',
  'audio-streams',
  'video-pts',
  'video-decode',
  'audio-decode',
  'pixel',
  'black-frame',
  'audio-sync',
]);

/**
 * Builds the final-artifact contract from the immutable manifest sent to the
 * Worker. `frameCount` is included because the Worker normalizes its remux to
 * that exact authored cadence; it must never be inferred from final Blob
 * metadata after the fact.
 */
export function createFinalEncodedExportExpectation(
  manifest: FinalExportVerificationManifest,
): FinalEncodedExportExpectation {
  const frozen = normalizeManifest(manifest);
  const frameDurationUs = 1_000_000 / frozen.frameRate;
  const expectedVideoPtsUs = Object.freeze(
    Array.from({ length: frozen.frameCount }, (_, index) =>
      // FFmpeg's `setpts=N/(fps*TB)` writes this authored CFR sequence. The
      // browser decoder exposes packet microseconds by truncating the MP4
      // time-base value, so use that same identity conversion rather than
      // rounding to a nearby, but different, PTS.
      Math.trunc(index * frameDurationUs),
    ),
  );

  return Object.freeze({
    container: 'mp4',
    width: frozen.width,
    height: frozen.height,
    durationUs: frozen.durationUs,
    expectedVideoPtsUs,
    // The Worker uses H.264 externally, while the final browser decoder's
    // stable public token for that MP4 stream is `avc`. Keep this seam
    // explicit: the verifier compares its decoder contract, not FFmpeg's
    // encoder naming.
    videoCodec: 'avc',
    audioCodec: 'aac',
    videoStreamCount: 1,
    audioStreamCount: 1,
    // The Worker has an existing one-frame duration contract. Keep that
    // allowance within the verifier's bounded request shape for a sub-frame
    // authored duration. It also resets PTS to this known CFR sequence, so do
    // not silently allow PTS drift.
    durationToleranceUs: Math.min(frozen.durationUs, Math.max(1, Math.ceil(frameDurationUs))),
    videoPtsToleranceUs: 0,
    // A source/canvas-derived creative predicate is not final-output proof.
    // Add these only when an explicit runtime capture contract can provide it.
    visualPredicates: Object.freeze([]),
    audioSyncPredicates: Object.freeze([]),
  });
}

/** Converts a verifier reply to the only receipt shape process history stores. */
export function createFinalExportVerificationReceipt(
  result: Exclude<FinalEncodedExportVerificationResult, { readonly status: 'cancelled' }>,
  input: { readonly decoderVersion: string; readonly checkedAt?: string },
): FinalExportVerificationReceipt {
  const decoderVersion = normalizeVersion(input.decoderVersion);
  const checkedAt = normalizeCheckedAt(input.checkedAt ?? new Date().toISOString());
  const base = {
    verifierVersion: FINAL_EXPORT_VERIFICATION_RECEIPT_VERIFIER_VERSION,
    decoderVersion,
    checkedAt,
  } as const;

  if (result.status === 'verified') {
    const facts = normalizeFacts(result.facts);
    return Object.freeze({
      ...base,
      status: 'verified' as const,
      scope: 'decoded-final-encoded-export' as const,
      facts,
      checkKinds: Object.freeze(result.checks.map((check) => check.kind)),
    });
  }
  if (result.status === 'failed')
    return Object.freeze({ ...base, status: 'failed' as const, code: result.code });
  if (result.status === 'unavailable')
    return Object.freeze({ ...base, status: 'unavailable' as const, code: result.code });
  return Object.freeze({ ...base, status: 'blocked' as const, code: result.code });
}

/** Safe, user-facing wording: no decoder/provider/asset implementation text. */
export function finalExportVerificationMessage(receipt: FinalExportVerificationReceipt): string {
  switch (receipt.status) {
    case 'verified':
      return 'Final MP4 verified.';
    case 'unavailable':
      return `Final MP4 requires browser verification (${receipt.code}).`;
    case 'blocked':
      return `Final MP4 verification was blocked (${receipt.code}).`;
    case 'failed':
      return `Final MP4 verification failed (${receipt.code}).`;
  }
}

/**
 * Raised after a non-cancelled verification result. Its message is derived
 * only from the sanitized receipt, so the general export error path cannot
 * accidentally expose decoder implementation text.
 */
export class FinalExportVerificationGateError extends Error {
  constructor(readonly receipt: FinalExportVerificationReceipt) {
    super(finalExportVerificationMessage(receipt));
    this.name = 'FinalExportVerificationGateError';
  }
}

export function isFinalExportVerificationGateError(
  value: unknown,
): value is FinalExportVerificationGateError {
  return value instanceof FinalExportVerificationGateError;
}

export function isFinalExportVerificationReceipt(
  value: unknown,
): value is FinalExportVerificationReceipt {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const receipt = value as Partial<FinalExportVerificationReceipt>;
  if (
    receipt.verifierVersion !== FINAL_EXPORT_VERIFICATION_RECEIPT_VERIFIER_VERSION ||
    typeof receipt.decoderVersion !== 'string' ||
    !SAFE_VERSION.test(receipt.decoderVersion) ||
    typeof receipt.checkedAt !== 'string' ||
    !isIsoTimestamp(receipt.checkedAt)
  )
    return false;
  if (receipt.status === 'verified')
    return (
      hasExactKeys(receipt, [
        'verifierVersion',
        'decoderVersion',
        'checkedAt',
        'status',
        'scope',
        'facts',
        'checkKinds',
      ]) &&
      receipt.scope === 'decoded-final-encoded-export' &&
      isFacts(receipt.facts) &&
      Array.isArray(receipt.checkKinds) &&
      receipt.checkKinds.every((kind) => CHECK_KINDS.includes(kind))
    );
  if (receipt.status === 'failed')
    return (
      hasExactKeys(receipt, ['verifierVersion', 'decoderVersion', 'checkedAt', 'status', 'code']) &&
      isFailureCode(receipt.code)
    );
  if (receipt.status === 'unavailable')
    return (
      hasExactKeys(receipt, ['verifierVersion', 'decoderVersion', 'checkedAt', 'status', 'code']) &&
      isUnavailableCode(receipt.code)
    );
  return (
    receipt.status === 'blocked' &&
    hasExactKeys(receipt, ['verifierVersion', 'decoderVersion', 'checkedAt', 'status', 'code']) &&
    isBlockedCode(receipt.code)
  );
}

function normalizeManifest(
  input: FinalExportVerificationManifest,
): FinalExportVerificationManifest {
  if (
    input === null ||
    typeof input !== 'object' ||
    !isPositiveSafeInteger(input.width) ||
    !isPositiveSafeInteger(input.height) ||
    !Number.isFinite(input.frameRate) ||
    input.frameRate <= 0 ||
    input.frameRate > 120 ||
    !isPositiveSafeInteger(input.durationUs) ||
    !isPositiveSafeInteger(input.frameCount) ||
    input.frameCount > MAX_EXPECTED_PRESENTATION_PTS
  )
    throw new RangeError('Final export verification manifest is outside the bounded contract.');
  const expectedFrameCount = Math.max(
    1,
    Math.round((input.durationUs / 1_000_000) * input.frameRate),
  );
  if (input.frameCount !== expectedFrameCount)
    throw new RangeError('Final export verification frame count differs from its manifest.');
  return Object.freeze({ ...input });
}

function normalizeVersion(value: string): string {
  if (!SAFE_VERSION.test(value))
    throw new TypeError('decoderVersion must be a safe version token.');
  return value;
}

function normalizeCheckedAt(value: string): string {
  if (!isIsoTimestamp(value)) throw new TypeError('checkedAt must be an ISO timestamp.');
  return value;
}

function normalizeFacts(input: unknown): FinalExportVerificationFacts {
  if (!isFacts(input)) throw new TypeError('Final export verification facts are invalid.');
  return Object.freeze({ ...input });
}

function isFacts(value: unknown): value is FinalExportVerificationFacts {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const facts = value as Partial<FinalExportVerificationFacts>;
  return (
    hasExactKeys(facts, [
      'container',
      'width',
      'height',
      'durationUs',
      'videoStreamCount',
      'audioStreamCount',
      'presentationFrameCount',
    ]) &&
    facts.container === 'mp4' &&
    isPositiveSafeInteger(facts.width) &&
    isPositiveSafeInteger(facts.height) &&
    isPositiveSafeInteger(facts.durationUs) &&
    isPositiveSafeInteger(facts.videoStreamCount) &&
    isPositiveSafeInteger(facts.audioStreamCount) &&
    isPositiveSafeInteger(facts.presentationFrameCount)
  );
}

function isFailureCode(value: unknown): value is FinalExportVerificationFailureCode {
  return (
    value === 'artifact-too-large' ||
    value === 'decoder-failed' ||
    value === 'invalid-decoder-output' ||
    value === 'decoded-pixel-budget-exceeded' ||
    value === 'decoded-audio-budget-exceeded' ||
    value === 'container-mismatch' ||
    value === 'dimensions-mismatch' ||
    value === 'duration-mismatch' ||
    value === 'video-streams-mismatch' ||
    value === 'audio-streams-mismatch' ||
    value === 'video-codec-mismatch' ||
    value === 'audio-codec-mismatch' ||
    value === 'video-pts-incomplete' ||
    value === 'video-pts-mismatch' ||
    value === 'missing-decoded-frame' ||
    value === 'missing-decoded-audio' ||
    value === 'pixel-predicate-failed' ||
    value === 'black-frame-predicate-failed' ||
    value === 'audio-sync-predicate-failed'
  );
}

function isUnavailableCode(value: unknown): value is FinalExportVerificationUnavailableCode {
  return (
    value === 'decoder-unavailable' ||
    value === 'decoder-not-actual' ||
    value === 'format-unsupported'
  );
}

function isBlockedCode(value: unknown): value is FinalExportVerificationBlockedCode {
  return value === 'artifact-not-readable' || value === 'decoder-policy';
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isIsoTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && /^\d{4}-\d{2}-\d{2}T/.test(value);
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    keys.length === sortedExpected.length &&
    keys.every((key, index) => key === sortedExpected[index])
  );
}
