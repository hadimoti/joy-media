/**
 * Motion Studio keyframe evaluator.
 * Pure function: given a MotionSceneDocument and a time in milliseconds,
 * returns an evaluation result with per-layer resolved transforms and style
 * overrides. Supports keyframe interpolation, hold, and cubic-bezier easing.
 */

import type {
  MotionAnimation,
  MotionEasing,
  MotionEasingName,
  MotionKeyframe,
  MotionKeyframeCurve,
  MotionLayer,
  MotionLayerId,
  MotionSceneDocument,
  MotionTransform,
} from './scene.js';

export interface EvaluatedTransform extends Partial<MotionTransform> {
  readonly __evaluated?: true;
}

export interface LayerEvaluation {
  readonly transform?: EvaluatedTransform;
  readonly opacity?: number | undefined;
}

export interface LayerWorldEvaluation {
  readonly worldTransform: MotionTransform;
  readonly opacity: number;
}

export type SceneEvaluation = ReadonlyMap<MotionLayerId, LayerEvaluation>;

type AnimatableTransformKey = keyof MotionTransform;

type EasingFunction = (t: number) => number;

const EASING_PRESETS: Record<MotionEasingName, EasingFunction> = {
  linear: (t) => t,
  'ease-in': (t) => t * t,
  'ease-out': (t) => 1 - (1 - t) * (1 - t),
  'ease-in-out': (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  ease: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  cubic: (t) => t * t * t,
  quart: (t) => t * t * t * t,
  quint: (t) => t * t * t * t * t,
  expo: (t) => (t === 0 ? 0 : Math.pow(2, 10 * (t - 1))),
  back: (t) => 2.7 * t * t * t - 1.5 * t * t,
  bounce: (t) => {
    const n1 = 7.5625;
    const d1 = 2.75;
    if (t < 1 / d1) return n1 * t * t;
    if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
    if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
    return n1 * (t -= 2.625 / d1) * t + 0.984375;
  },
  elastic: (t) => {
    if (t === 0) return 0;
    if (t === 1) return 1;
    return -Math.pow(2, 10 * t - 10) * Math.sin((t * 10 - 10.75) * ((2 * Math.PI) / 3));
  },
  steps: (t) => Math.floor(t * 4) / 4,
  spring: (t) => {
    if (t === 0 || t === 1) return t;
    const p = 0.3;
    const s = p / 4;
    return 1 + Math.pow(2, -10 * t) * Math.sin(((t - s) * (2 * Math.PI)) / p);
  },
};

function easingFrom(easing: MotionEasing): EasingFunction {
  if (easing.kind === 'builtin') return EASING_PRESETS[easing.name] ?? EASING_PRESETS.linear;
  const { x1, y1, x2, y2 } = easing;
  return cubicBezier(x1, y1, x2, y2);
}

function cubicBezier(x1: number, y1: number, x2: number, y2: number): EasingFunction {
  return (t: number) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    const cx = 3 * x1;
    const bx = 3 * (x2 - x1) - cx;
    const ax = 1 - cx - bx;
    const cy = 3 * y1;
    const by = 3 * (y2 - y1) - cy;
    const ay = 1 - cy - by;
    let x = t;
    for (let i = 0; i < 8; i += 1) {
      const value = ((ax * x + bx) * x + cx) * x;
      const error = value - t;
      if (Math.abs(error) < 1e-6) break;
      const slope = (3 * ax * x + 2 * bx) * x + cx;
      if (Math.abs(slope) < 1e-6) break;
      x -= error / slope;
    }
    return ((ay * x + by) * x + cy) * x;
  };
}

function interpolate(curve: MotionKeyframeCurve, timeMs: number): number | undefined {
  const keyframes = curve.keyframes;
  if (keyframes.length === 0) return undefined;
  if (keyframes.length === 1) return keyframes[0]!.value;
  const sorted = [...keyframes].sort((a, b) => a.timeMs - b.timeMs);
  if (timeMs <= sorted[0]!.timeMs) return sorted[0]!.value;
  const last = sorted[sorted.length - 1]!;
  if (timeMs >= last.timeMs) return last.value;

  for (let i = 0; i < sorted.length - 1; i += 1) {
    const left = sorted[i]!;
    const right = sorted[i + 1]!;
    if (timeMs >= left.timeMs && timeMs <= right.timeMs) {
      if (left.hold) return left.value;
      const span = right.timeMs - left.timeMs;
      if (span <= 0) return left.value;
      const t = (timeMs - left.timeMs) / span;
      const eased = easingFrom(left.easing)(t);
      return left.value + (right.value - left.value) * eased;
    }
  }
  return last.value;
}

const TRANSFORM_PATHS: Record<string, AnimatableTransformKey> = {
  'transform.x': 'x',
  'transform.y': 'y',
  'transform.z': 'z',
  'transform.width': 'width',
  'transform.height': 'height',
  'transform.scaleX': 'scaleX',
  'transform.scaleY': 'scaleY',
  'transform.rotationDeg': 'rotationDeg',
  'transform.rotationXDeg': 'rotationXDeg',
  'transform.rotationYDeg': 'rotationYDeg',
  'transform.skewX': 'skewX',
  'transform.skewY': 'skewY',
  'transform.opacity': 'opacity',
};

function evaluateLayer(layer: MotionLayer, timeMs: number): LayerEvaluation {
  const transformPatch: Record<string, number> = {};
  let opacity: number | undefined;

  for (const animation of layer.animations) {
    const value = interpolate(animation.curve, timeMs);
    if (value === undefined) continue;

    if (animation.property === 'transform.opacity') {
      transformPatch.opacity = value;
    } else if (animation.property.startsWith('transform.')) {
      const key = TRANSFORM_PATHS[animation.property];
      if (key) transformPatch[key] = value;
    } else if (animation.property === 'fill.opacity') {
      // Handled separately by renderer if needed.
    }
  }

  if (Object.keys(transformPatch).length === 0) {
    return opacity !== undefined ? { opacity } : {};
  }
  if (opacity !== undefined) {
    return { transform: transformPatch as EvaluatedTransform, opacity };
  }
  return { transform: transformPatch as EvaluatedTransform };
}

export function evaluateMotionScene(document: MotionSceneDocument, timeMs: number): SceneEvaluation {
  const result = new Map<MotionLayerId, LayerEvaluation>();
  const clampedTime = Math.max(0, timeMs);
  for (const layer of document.layers) {
    const evaluation = evaluateLayer(layer, clampedTime);
    if (evaluation.transform || evaluation.opacity !== undefined) {
      result.set(layer.id, evaluation);
    }
  }
  return result;
}

/**
 * Merge a layer's static transform with evaluated overrides.
 */
export function resolvedLayerTransform(layer: MotionLayer, evaluation: LayerEvaluation | undefined): MotionTransform {
  if (!evaluation?.transform) return layer.transform;
  return { ...layer.transform, ...evaluation.transform };
}

export function resolvedLayerOpacity(layer: MotionLayer, evaluation: LayerEvaluation | undefined): number {
  if (evaluation?.opacity !== undefined) return evaluation.opacity;
  return layer.transform.opacity;
}

/**
 * Compute a keyframe value for the current time, inserting or updating the
 * curve for a given property. Returns a new animations array.
 */
export function setKeyframeAt(
  animations: readonly MotionAnimation[],
  property: string,
  timeMs: number,
  value: number,
  easing: MotionEasing = { kind: 'builtin', name: 'linear' },
): readonly MotionAnimation[] {
  const copy = [...animations];
  const index = copy.findIndex((a) => a.property === property);
  if (index === -1) {
    return [
      ...copy,
      {
        property,
        curve: {
          keyframes: [
            { id: crypto.randomUUID(), timeMs: Math.max(0, timeMs), value, easing },
          ],
        },
      },
    ];
  }

  const animation = copy[index]!;
  const keyframes = [...animation.curve.keyframes];
  const existing = keyframes.findIndex((k) => Math.abs(k.timeMs - timeMs) < 1);
  if (existing !== -1) {
    keyframes[existing] = { ...keyframes[existing]!, value, easing };
  } else {
    keyframes.push({ id: crypto.randomUUID(), timeMs: Math.max(0, timeMs), value, easing });
    keyframes.sort((a, b) => a.timeMs - b.timeMs);
  }
  copy[index] = { ...animation, curve: { ...animation.curve, keyframes } };
  return copy;
}

export function removeKeyframeAt(
  animations: readonly MotionAnimation[],
  property: string,
  timeMs: number,
): readonly MotionAnimation[] {
  let changed = false;
  const result = animations.map((animation) => {
    if (animation.property !== property) return animation;
    const keyframes = animation.curve.keyframes.filter((k) => Math.abs(k.timeMs - timeMs) >= 1);
    if (keyframes.length === animation.curve.keyframes.length) return animation;
    changed = true;
    return { ...animation, curve: { ...animation.curve, keyframes } };
  });
  return changed ? result.filter((a) => a.curve.keyframes.length > 0) : result;
}

/** Check whether a layer has any keyframe for the given property at the time. */
export function hasKeyframeAt(animation: MotionAnimation | undefined, timeMs: number): boolean {
  if (!animation) return false;
  return animation.curve.keyframes.some((k) => Math.abs(k.timeMs - timeMs) < 1);
}

/** Compose static/evaluated local transform with parent chain for a layer. */
export function resolveLayerWorld(
  layer: MotionLayer,
  evaluation: LayerEvaluation | undefined,
  layersById: Readonly<Record<string, MotionLayer>>,
): LayerWorldEvaluation {
  const local = resolvedLayerTransform(layer, evaluation);
  const opacity = resolvedLayerOpacity(layer, evaluation);
  const chain: MotionLayer[] = [];
  const seen = new Set<string>([layer.id]);
  let parentId = layer.parentId;
  while (parentId !== undefined) {
    if (seen.has(parentId)) break;
    const parent = layersById[parentId];
    if (parent === undefined) break;
    chain.push(parent);
    seen.add(parentId);
    parentId = parent.parentId;
  }
  let world: MotionTransform = local;
  for (let i = chain.length - 1; i >= 0; i--) {
    const parent = chain[i]!;
    const parentWorld = resolvedLayerTransform(parent, undefined);
    world = composeParentWorld(parentWorld, world);
  }
  return { worldTransform: world, opacity };
}

function composeParentWorld(parentWorld: MotionTransform, local: MotionTransform): MotionTransform {
  const radians = (parentWorld.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const scaledX = parentWorld.scaleX * local.x;
  const scaledY = parentWorld.scaleY * local.y;
  return {
    x: parentWorld.x + scaledX * cos - scaledY * sin,
    y: parentWorld.y + scaledX * sin + scaledY * cos,
    z: local.z,
    width: local.width,
    height: local.height,
    scaleX: parentWorld.scaleX * local.scaleX,
    scaleY: parentWorld.scaleY * local.scaleY,
    rotationDeg: parentWorld.rotationDeg + local.rotationDeg,
    rotationXDeg: local.rotationXDeg,
    rotationYDeg: local.rotationYDeg,
    skewX: parentWorld.skewX + local.skewX,
    skewY: parentWorld.skewY + local.skewY,
    transformOriginX: local.transformOriginX,
    transformOriginY: local.transformOriginY,
    perspective: parentWorld.perspective + local.perspective,
    opacity: parentWorld.opacity * local.opacity,
  };
}
