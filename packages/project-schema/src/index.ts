/**
 * @joy-media/project-schema — versioned creative document schema and migrations.
 *
 * WP-00.1 state: durable time primitives (ADR-0002) and the P00 spike subset of
 * the project model. Schema v1 + migrations land in P01 (WP-01.1).
 */
export const PACKAGE_NAME = '@joy-media/project-schema' as const;

export type { TimeUs, Rational, TimeRange } from './time.js';
export {
  rational,
  normalizeRational,
  rationalsEqual,
  compareRationals,
  frameStartUs,
  frameIndexAtUs,
  snapUsToFrame,
  timeRange,
  clipTimeRange,
  rangeEndUs,
  rangeContainsUs,
  intersectRanges,
} from './time.js';

export type {
  ProjectId,
  CompositionId,
  TrackId,
  ClipId,
  AssetId,
  SpikeProject,
  Composition,
  Track,
  Clip,
  VideoClip,
  CompositionClip,
  ProjectDiagnostic,
} from './model.js';
export { validateSpikeProject } from './model.js';
