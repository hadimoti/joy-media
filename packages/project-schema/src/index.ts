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

export type {
  JoyProjectV1,
  CompositionV1,
  TrackV1,
  ClipV1,
  VideoClipV1,
  CompositionClipV1,
  CaptionClipV1,
  CaptionWordV1,
  CaptionSegmentV1,
  CaptionSpeakerV1,
  CaptionDocumentV1,
  AssetRecordV1,
  MarkerV1,
  VisualObjectV1,
  VisualObjectTransformV1,
  AnimatablePropertyV1,
  KeyframeInterpolationV1,
  BezierHandlesV1,
  KeyframeV1,
  AnimationCurveV1,
  JsonValue,
} from './v1.js';
export { validateJoyProjectV1, validateAnimationCurve, ANIMATABLE_PROPERTIES } from './v1.js';
export type { MigrationReport, MigrationResult } from './migration.js';
export { migrateV0ToV1 } from './migration.js';
