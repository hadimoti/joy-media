import type {
  AnimationCurveV1,
  KeyframeInterpolationV1,
  KeyframeV1,
  PropertyAnimationV2,
  PropertyBindingV2,
} from '@joy-media/project-schema';
import type { MotionAnimation, MotionEasing, MotionKeyframe, MotionLayer } from './scene.js';

/** Stable shared binding for a Motion Studio scalar channel. */
export function motionBinding(layerId: string, propertyId: string): PropertyBindingV2 {
  return {
    ownerKind: 'motion-scene-layer',
    ownerId: layerId,
    propertyId,
    timeDomain: 'scene-local',
  };
}

/** Converts one existing Motion curve into the universal scalar shape. */
export function motionAnimationToUniversal(
  layer: Pick<MotionLayer, 'id'>,
  animation: MotionAnimation,
): PropertyAnimationV2 {
  return {
    binding: motionBinding(layer.id, animation.property),
    value: {
      kind: 'scalar',
      curve: {
        keyframes: animation.curve.keyframes.map((keyframe) => toUniversalKeyframe(keyframe)),
      },
    },
  };
}

/** Exposes all Motion Studio scalar channels through the shared property contract. */
export function motionLayerToUniversalAnimations(
  layer: Pick<MotionLayer, 'id' | 'animations'>,
): readonly PropertyAnimationV2[] {
  return layer.animations.map((animation) => motionAnimationToUniversal(layer, animation));
}

/** Converts a universal scalar binding back to a Motion Studio animation. */
export function universalToMotionAnimation(
  animation: PropertyAnimationV2,
): MotionAnimation | undefined {
  if (
    animation.binding.ownerKind !== 'motion-scene-layer' ||
    animation.binding.timeDomain !== 'scene-local' ||
    animation.value.kind !== 'scalar'
  )
    return undefined;
  return {
    property: animation.binding.propertyId,
    curve: {
      keyframes: animation.value.curve.keyframes.map((keyframe, index) => ({
        id: `universal:${animation.binding.ownerId}:${animation.binding.propertyId}:${keyframe.timeUs}:${index}`,
        timeMs: keyframe.timeUs / 1000,
        value: keyframe.value,
        easing: fromUniversalInterpolation(keyframe),
        ...(keyframe.interpolation === 'hold' ? { hold: true } : {}),
      })),
    },
  };
}

function toUniversalKeyframe(keyframe: MotionKeyframe): KeyframeV1 {
  const interpolation: KeyframeInterpolationV1 = keyframe.hold
    ? 'hold'
    : keyframe.easing.kind === 'cubic-bezier'
      ? 'bezier'
      : keyframe.easing.name === 'linear'
        ? 'linear'
        : 'eased';
  return {
    timeUs: Math.max(0, Math.round(keyframe.timeMs * 1000)),
    value: keyframe.value,
    interpolation,
    ...(keyframe.easing.kind === 'cubic-bezier' ? { bezier: keyframe.easing } : {}),
  };
}

function fromUniversalInterpolation(keyframe: KeyframeV1): MotionEasing {
  if (keyframe.interpolation === 'bezier' && keyframe.bezier !== undefined)
    return { kind: 'cubic-bezier', ...keyframe.bezier };
  return {
    kind: 'builtin',
    name: keyframe.interpolation === 'linear' ? 'linear' : 'ease',
  };
}

/** Converts a universal curve only when it is a valid Motion scalar binding. */
export function universalCurveForMotion(
  animation: PropertyAnimationV2,
): AnimationCurveV1 | undefined {
  return animation.value.kind === 'scalar' &&
    animation.binding.ownerKind === 'motion-scene-layer' &&
    animation.binding.timeDomain === 'scene-local'
    ? animation.value.curve
    : undefined;
}
