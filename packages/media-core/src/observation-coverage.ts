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

/**
 * Provider video is deliberately never exhaustive: the provider may sample or
 * otherwise transform the video after submission. "Reviewed" only means that
 * input was tied to a completed model analysis.
 */
export function hasExhaustiveInputCoverage(coverage: EvidenceCoverage): boolean {
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
  const requestedEnd = requested.startUs + requested.durationUs;
  const frameEnd = frame.startUs + frame.durationUs;
  return frame.startUs < requestedEnd && frameEnd > requested.startUs;
}

export function summarizeEvidenceCoverage(coverage: EvidenceCoverage): EvidenceCoverageSummary {
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
