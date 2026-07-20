/**
 * @joy-media/evaluator — time-based document evaluation (pure).
 *
 * WP-01.3 state: exact frame evaluation plus active interval/static property helpers.
 */
export const PACKAGE_NAME = '@joy-media/evaluator' as const;

export type { EvaluatedFrame, EvaluatedVideoFrame } from './evaluate.js';
export { evaluateFrame } from './evaluate.js';
export type { EvaluatedExpressionTransform, StaticProperty, TimedEntity } from './properties.js';
export {
  evaluateAnimatedTransform,
  evaluateCameraTransform,
  evaluateExpressionTransform,
  evaluateStaticProperty,
  queryActiveIntervals,
} from './properties.js';
