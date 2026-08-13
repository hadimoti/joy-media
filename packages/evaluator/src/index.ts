/**
 * @joy-media/evaluator — time-based document evaluation (pure).
 *
 * WP-01.3 state: exact frame evaluation plus active interval/static property helpers.
 */
export const PACKAGE_NAME = '@joy-media/evaluator' as const;

export type { EvaluatedFrame, EvaluatedVideoFrame } from './evaluate.js';
export { evaluateFrame } from './evaluate.js';
export type {
  AnimationLocalTimeRange,
  PropertyAnimationTimeContext,
  ResolvedPropertyAnimationTime,
} from './property-time-domain.js';
export { resolvePropertyAnimationTime } from './property-time-domain.js';
export type {
  EvaluatedFrameProperty,
  FramePropertyDiagnostic,
  FramePropertyEvaluatorRequest,
  FramePropertyExpression,
  FramePropertySource,
  FramePropertyValue,
  LegacyPropertyAnimationAdapter,
} from './frame-property-evaluator.js';
export { evaluateFrameProperty } from './frame-property-evaluator.js';
export type { EvaluatedExpressionTransform, StaticProperty, TimedEntity } from './properties.js';
export {
  evaluateAnimatedTransform,
  evaluateCameraExpressionTransform,
  evaluateCameraTransform,
  evaluateExpressionTransform,
  evaluateStaticProperty,
  queryActiveIntervals,
} from './properties.js';
