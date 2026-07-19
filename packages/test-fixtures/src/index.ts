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
