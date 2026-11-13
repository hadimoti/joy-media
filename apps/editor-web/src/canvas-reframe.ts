import type {
  AnimationCurveV1,
  JoyProjectV1,
  SpatialPathV1,
  VisualObjectV1,
} from '@joy-media/project-schema';
import { readClipObjectIdsMap } from './sticker-bindings.js';

export type CanvasReframeMode = 'fit' | 'fill' | 'keep';

export interface CanvasSize {
  readonly width: number;
  readonly height: number;
}

export function shouldAskCanvasReframe(
  source: CanvasSize,
  target: CanvasSize,
  hasTimelineClips: boolean,
): boolean {
  return hasTimelineClips && (source.width !== target.width || source.height !== target.height);
}

/**
 * Reframe the visual objects bound to clips in the root composition.
 * Fit/Fill scale the old composition uniformly around its centre; Keep leaves
 * the clip transforms untouched. The renderer and both export paths consume
 * this same project document.
 */
export function reframeProjectClips(
  project: JoyProjectV1,
  target: CanvasSize,
  mode: CanvasReframeMode,
): JoyProjectV1 {
  if (mode === 'keep') return project;
  const composition = project.compositions[project.rootCompositionId];
  if (composition === undefined) return project;
  const scale = canvasReframeScale(
    { width: composition.width, height: composition.height },
    target,
    mode,
  );
  if (scale === undefined) return project;

  const clipIds = new Set(
    composition.tracks.flatMap((track) => track.clips.map((clip) => clip.id)),
  );
  const objectIds = new Set(
    Object.entries(readClipObjectIdsMap(project))
      .filter(([clipId]) => clipIds.has(clipId))
      .flatMap(([, objectIds]) => objectIds),
  );
  if (objectIds.size === 0) return project;

  const visualObjects = { ...project.visualObjects };
  for (const objectId of objectIds) {
    const object = visualObjects[objectId];
    if (object === undefined) continue;
    visualObjects[objectId] = scaleVisualObject(
      object,
      { width: composition.width, height: composition.height },
      target,
      scale,
    );
  }
  return { ...project, visualObjects };
}

export function canvasReframeScale(
  source: CanvasSize,
  target: CanvasSize,
  mode: Exclude<CanvasReframeMode, 'keep'>,
): number | undefined {
  if (
    ![source.width, source.height, target.width, target.height].every(
      (value) => Number.isFinite(value) && value > 0,
    )
  )
    return undefined;
  const widthScale = target.width / source.width;
  const heightScale = target.height / source.height;
  return mode === 'fit' ? Math.min(widthScale, heightScale) : Math.max(widthScale, heightScale);
}

function scaleVisualObject(
  object: VisualObjectV1,
  source: CanvasSize,
  target: CanvasSize,
  scale: number,
): VisualObjectV1 {
  const transform = object.transform;
  const mapX = (value: number) => target.width / 2 + (value - source.width / 2) * scale;
  const mapY = (value: number) => target.height / 2 + (value - source.height / 2) * scale;
  const animations = object.animations;
  const nextAnimations =
    animations === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(animations).map(([property, curve]) => [
            property,
            curve === undefined ? curve : scaleAnimation(curve, property, mapX, mapY, scale),
          ]),
        );
  const expressions = object.expressions;
  const nextExpressions =
    expressions === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(expressions).map(([property, expression]) => {
            if (expression === undefined) return [property, expression];
            if (property === 'x')
              return [
                property,
                `((${expression}) - ${source.width / 2}) * ${scale} + ${target.width / 2}`,
              ];
            if (property === 'y')
              return [
                property,
                `((${expression}) - ${source.height / 2}) * ${scale} + ${target.height / 2}`,
              ];
            if (property === 'scaleX' || property === 'scaleY')
              return [property, `((${expression}) * ${scale})`];
            return [property, expression];
          }),
        );
  const spatialPath = object.spatialPath;

  return {
    ...object,
    transform: {
      ...transform,
      x: mapX(transform.x),
      y: mapY(transform.y),
      scaleX: transform.scaleX * scale,
      scaleY: transform.scaleY * scale,
    },
    ...(nextAnimations === undefined ? {} : { animations: nextAnimations }),
    ...(nextExpressions === undefined ? {} : { expressions: nextExpressions }),
    ...(spatialPath === undefined
      ? {}
      : { spatialPath: scaleSpatialPath(spatialPath, mapX, mapY, scale) }),
  };
}

function scaleAnimation(
  curve: AnimationCurveV1,
  property: string,
  mapX: (value: number) => number,
  mapY: (value: number) => number,
  scale: number,
): AnimationCurveV1 {
  if (property !== 'x' && property !== 'y' && property !== 'scaleX' && property !== 'scaleY')
    return curve;
  return {
    ...curve,
    keyframes: curve.keyframes.map((keyframe) => ({
      ...keyframe,
      value:
        property === 'x'
          ? mapX(keyframe.value)
          : property === 'y'
            ? mapY(keyframe.value)
            : keyframe.value * scale,
    })),
  };
}

function scaleSpatialPath(
  path: SpatialPathV1,
  mapX: (value: number) => number,
  mapY: (value: number) => number,
  scale: number,
): SpatialPathV1 {
  return {
    ...path,
    keyframes: path.keyframes.map((keyframe) => ({
      ...keyframe,
      point: { x: mapX(keyframe.point.x), y: mapY(keyframe.point.y) },
      ...(keyframe.inTangent === undefined
        ? {}
        : {
            inTangent: {
              x: keyframe.inTangent.x * scale,
              y: keyframe.inTangent.y * scale,
            },
          }),
      ...(keyframe.outTangent === undefined
        ? {}
        : {
            outTangent: {
              x: keyframe.outTangent.x * scale,
              y: keyframe.outTangent.y * scale,
            },
          }),
    })),
  };
}
