export type ObservationMode = 'overview' | 'focus' | 'exhaustive' | 'provider-video';
export type EvidenceCoverageStatus = 'running' | 'complete' | 'partial' | 'failed' | 'cancelled';

/** Bounded page data; large source indexes live in paged local manifests. */
export interface EvidenceCoverage {
  readonly mode: ObservationMode;
  readonly intendedFrameIds: readonly string[];
  readonly decodedFrameIds: readonly string[];
  readonly submittedFrameIds: readonly string[];
  readonly reviewedFrameIds: readonly string[];
  readonly status: EvidenceCoverageStatus;
  readonly omittedReason?: string;
}

export interface HalfOpenTimeRange {
  readonly startUs: number;
  readonly durationUs: number;
}

export interface EvidenceCoverageSummary {
  readonly mode: ObservationMode;
  readonly status: EvidenceCoverageStatus;
  readonly intendedCount: number;
  readonly decodedCount: number;
  readonly submittedCount: number;
  readonly reviewedCount: number;
  readonly exhaustiveInput: boolean;
  readonly modelComprehensionGuaranteed: false;
  readonly omittedReason?: string;
}

/** Public coverage arrays are pages, never a complete feature-length index. */
export const MAX_EVIDENCE_COVERAGE_FRAME_IDS_PER_PAGE = 1_024;

const OBSERVATION_MODES: readonly ObservationMode[] = [
  'overview',
  'focus',
  'exhaustive',
  'provider-video',
];
const COVERAGE_STATUSES: readonly EvidenceCoverageStatus[] = [
  'running',
  'complete',
  'partial',
  'failed',
  'cancelled',
];
const COVERAGE_KEYS = [
  'mode',
  'intendedFrameIds',
  'decodedFrameIds',
  'submittedFrameIds',
  'reviewedFrameIds',
  'status',
] as const;
const FRAME_ID = /^[A-Za-z0-9][A-Za-z0-9._:@=-]{0,511}$/;
const MAX_OMITTED_REASON_LENGTH = 512;
const UNSAFE_LOCATION =
  /(?:\b(?:https?|file|data|blob):|\b[A-Za-z]:|(?:^|\s|=|:|\(|\[)(?:~?\/|\\\\)|(?:^|\/)\.{1,2}(?:\/|$)|\\)/i;

/** Bounded runtime schema for a single public evidence-coverage page. */
export function isEvidenceCoverage(value: unknown): value is EvidenceCoverage {
  if (!isPlainRecord(value) || !hasCoverageKeys(value)) return false;
  return (
    isObservationMode(value.mode) &&
    isEvidenceCoverageStatus(value.status) &&
    isBoundedFrameIdPage(value.intendedFrameIds) &&
    isBoundedFrameIdPage(value.decodedFrameIds) &&
    isBoundedFrameIdPage(value.submittedFrameIds) &&
    isBoundedFrameIdPage(value.reviewedFrameIds) &&
    (value.omittedReason === undefined || isSafeOmittedReason(value.omittedReason))
  );
}

export function assertEvidenceCoverage(value: unknown): asserts value is EvidenceCoverage {
  if (!isEvidenceCoverage(value))
    throw new RangeError('coverage must be a bounded page with opaque frame identifiers');
}

/**
 * Provider video is deliberately never exhaustive: the provider may sample or
 * otherwise transform the video after submission. "Reviewed" only means that
 * input was tied to a completed model analysis.
 */
export function hasExhaustiveInputCoverage(coverage: EvidenceCoverage): boolean {
  if (!isEvidenceCoverage(coverage)) return false;
  if (
    coverage.mode !== 'exhaustive' ||
    coverage.status !== 'complete' ||
    coverage.intendedFrameIds.length === 0
  )
    return false;
  const decoded = new Set(coverage.decodedFrameIds);
  const submitted = new Set(coverage.submittedFrameIds);
  const reviewed = new Set(coverage.reviewedFrameIds);
  return coverage.intendedFrameIds.every(
    (id) => decoded.has(id) && submitted.has(id) && reviewed.has(id),
  );
}

/** True when a decoded frame interval intersects a requested half-open range. */
export function isFrameWithinHalfOpenRange(
  requested: HalfOpenTimeRange,
  frame: HalfOpenTimeRange,
): boolean {
  assertRange(requested, 'requested');
  assertRange(frame, 'frame');
  if (requested.durationUs === 0 || frame.durationUs === 0) return false;
  const requestedEnd = requested.startUs + requested.durationUs;
  const frameEnd = frame.startUs + frame.durationUs;
  return frame.startUs < requestedEnd && frameEnd > requested.startUs;
}

export function summarizeEvidenceCoverage(coverage: EvidenceCoverage): EvidenceCoverageSummary {
  assertEvidenceCoverage(coverage);
  return {
    mode: coverage.mode,
    status: coverage.status,
    intendedCount: new Set(coverage.intendedFrameIds).size,
    decodedCount: new Set(coverage.decodedFrameIds).size,
    submittedCount: new Set(coverage.submittedFrameIds).size,
    reviewedCount: new Set(coverage.reviewedFrameIds).size,
    exhaustiveInput: hasExhaustiveInputCoverage(coverage),
    modelComprehensionGuaranteed: false,
    ...(coverage.omittedReason === undefined ? {} : { omittedReason: coverage.omittedReason }),
  };
}

function assertRange(range: HalfOpenTimeRange, label: string): void {
  if (
    !Number.isSafeInteger(range.startUs) ||
    !Number.isSafeInteger(range.durationUs) ||
    range.startUs < 0 ||
    range.durationUs < 0 ||
    range.startUs + range.durationUs > Number.MAX_SAFE_INTEGER
  )
    throw new RangeError(`${label} must be a non-negative safe integer half-open range`);
}

function isObservationMode(value: unknown): value is ObservationMode {
  return typeof value === 'string' && (OBSERVATION_MODES as readonly string[]).includes(value);
}

function isEvidenceCoverageStatus(value: unknown): value is EvidenceCoverageStatus {
  return typeof value === 'string' && (COVERAGE_STATUSES as readonly string[]).includes(value);
}

function isBoundedFrameIdPage(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_EVIDENCE_COVERAGE_FRAME_IDS_PER_PAGE &&
    value.every((id) => typeof id === 'string' && FRAME_ID.test(id) && !containsUnsafeLocation(id))
  );
}

function isSafeOmittedReason(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= MAX_OMITTED_REASON_LENGTH &&
    !containsUnsafeLocation(value)
  );
}

function containsUnsafeLocation(value: string): boolean {
  return UNSAFE_LOCATION.test(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasCoverageKeys(value: Record<string, unknown>): boolean {
  const actual = [...Object.getOwnPropertyNames(value), ...Object.getOwnPropertySymbols(value)];
  const hasOmittedReason = Object.prototype.hasOwnProperty.call(value, 'omittedReason');
  return (
    actual.length === COVERAGE_KEYS.length + (hasOmittedReason ? 1 : 0) &&
    COVERAGE_KEYS.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    (!hasOmittedReason || actual.includes('omittedReason'))
  );
}
