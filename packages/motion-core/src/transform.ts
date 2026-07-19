/**
 * Resolves a visual object's effective transform at a time by sampling any
 * animated channels and falling back to the static transform for the rest.
 * This is the "later evaluator pass" the WP-01.3 evaluator left as a promise.
 */

import type {
  AnimatablePropertyV1,
  AnimationCurveV1,
  TimeUs,
  VisualObjectTransformV1,
  VisualObjectV1,
} from '@joy-media/project-schema';
import { ANIMATABLE_PROPERTIES } from '@joy-media/project-schema';
import { sampleCurve } from './curve.js';

export type ObjectAnimations = Readonly<Partial<Record<AnimatablePropertyV1, AnimationCurveV1>>>;

/** True when the object animates at least one channel. */
export function isAnimated(object: VisualObjectV1): boolean {
  const animations = object.animations;
  return (
    animations !== undefined && ANIMATABLE_PROPERTIES.some((key) => animations[key] !== undefined)
  );
}

/**
 * Effective transform at `timeUs`. Animated channels are sampled; unanimated
 * channels keep their static value. Scale/opacity are clamped to their durable
 * invariants so a curve can never drive an object to an invalid state.
 */
export function resolveAnimatedTransform(
  transform: VisualObjectTransformV1,
  animations: ObjectAnimations | undefined,
  timeUs: TimeUs,
): VisualObjectTransformV1 {
  if (animations === undefined) return transform;
  const sampled: Record<AnimatablePropertyV1, number> = {
    x: transform.x,
    y: transform.y,
    scaleX: transform.scaleX,
    scaleY: transform.scaleY,
    rotationDeg: transform.rotationDeg,
    opacity: transform.opacity,
  };
  let touched = false;
  for (const key of ANIMATABLE_PROPERTIES) {
    const curve = animations[key];
    if (curve === undefined) continue;
    sampled[key] = sampleCurve(curve, timeUs);
    touched = true;
  }
  if (!touched) return transform;
  return {
    ...transform,
    x: sampled.x,
    y: sampled.y,
    scaleX: Math.max(0.001, sampled.scaleX),
    scaleY: Math.max(0.001, sampled.scaleY),
    rotationDeg: sampled.rotationDeg,
    opacity: Math.min(1, Math.max(0, sampled.opacity)),
  };
}

/** Convenience: resolve an object's transform at `timeUs`. */
export function resolveObjectTransform(
  object: VisualObjectV1,
  timeUs: TimeUs,
): VisualObjectTransformV1 {
  return resolveAnimatedTransform(object.transform, object.animations, timeUs);
}
