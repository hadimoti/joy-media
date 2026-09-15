/**
 * Browser-safe public surface for @joy-media/media-core.
 *
 * The default Node entry owns local-file bridges and SHA-256 cache keys, so it
 * intentionally imports Node's crypto implementation. The editor resolves this conditional
 * entry instead: it contains only pure evidence identity and cache-key logic.
 * Keeping the split here prevents an accidental browser crypto polyfill from
 * becoming part of the trust boundary.
 */
export const PACKAGE_NAME = '@joy-media/media-core' as const;

export type {
  CompositionEvidenceIdentity,
  FrameIdentity,
  ObservationFinding,
  ObservationPrivacyOrigin,
  SourceEvidenceIdentity,
} from './observation.js';
export {
  assertFrameIdentity,
  assertObservationFinding,
  createCompositionEvidenceIdentity,
  createSourceEvidenceIdentity,
  frameIdentityKey,
  isObservationPrivacyOrigin,
  ptsTicksToSourceTimeUs,
} from './observation.js';

export type {
  EvidenceCoverage,
  EvidenceCoverageStatus,
  EvidenceCoverageSummary,
  HalfOpenTimeRange,
  ObservationMode,
} from './observation-coverage.js';
export {
  assertEvidenceCoverage,
  hasExhaustiveInputCoverage,
  isEvidenceCoverage,
  isFrameWithinHalfOpenRange,
  MAX_EVIDENCE_COVERAGE_FRAME_IDS_PER_PAGE,
  summarizeEvidenceCoverage,
} from './observation-coverage.js';

export type { ObservationCacheCrop, ObservationCacheKeyInput } from './observation-cache-key.js';
export { createObservationCacheKey } from './observation-cache-key.js';
