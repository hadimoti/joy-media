/**
 * @joy-media/test-fixtures — golden projects and shared test fixtures.
 *
 * WP-00.2 state: spike-project builders used by command/evaluator tests.
 * Golden media fixtures land with WP-00.3+.
 */
export const PACKAGE_NAME = '@joy-media/test-fixtures' as const;

export {
  emptySpikeProject,
  makeVideoClip,
  makeCompositionClip,
  withClips,
  SECOND_US,
} from './spike.js';
export type { ReferenceProject } from './reference-project.js';
export { buildReferenceSpikeProject, REFERENCE_PROJECT } from './reference-project.js';
export type {
  TimelineScaleClip,
  TimelineScaleCounts,
  TimelineScaleFixture,
  TimelineScaleTrack,
} from './benchmark.js';
export {
  createTimelineScaleFixture,
  TIMELINE_SCALE_REFERENCE,
  TIMELINE_SCALE_SCALED_DOWN,
} from './benchmark.js';
export {
  createAnimationOwnershipFixture,
  createLegacyAnimationFixture,
} from './wp34-animation-fixtures.js';
