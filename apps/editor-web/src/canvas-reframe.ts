import type {
  AnimationCurveV1,
  JoyProjectV1,
  PropertyAnimationV2,
  SpatialPathV1,
  VisualObjectV1,
} from '@joy-media/project-schema';
import { calculateMediaFitTransform, type MediaFitTransform } from './media-fit-transform.js';
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
 *
 * A composition with an active camera is left alone entirely: the camera's
 * perspective projection already depends on the composition height and frames
 * every visual layer, so remapping the clips and the camera would scale twice.
 */
export function reframeProjectClips(
  project: JoyProjectV1,
  target: CanvasSize,
  mode: CanvasReframeMode,
): JoyProjectV1 {
  if (mode === 'keep') return project;
  if (canvasReframeIsCameraFramed(project)) return project;
  const composition = project.compositions[project.rootCompositionId];
  if (composition === undefined) return project;
  const reframe = canvasReframeTransform(
    { width: composition.width, height: composition.height },
    target,
    mode,
  );
  if (reframe === undefined) return project;

  const objectIds = collectCanvasReframeObjectIds(project);
  if (objectIds.size === 0) return project;

  const visualObjects = { ...project.visualObjects };
  const skippedObjectIds = collectCanvasReframeSkippedObjectIds(project, objectIds);
  let changed = false;
  for (const objectId of objectIds) {
    const object = visualObjects[objectId];
    if (object === undefined) continue;
    if (skippedObjectIds.has(objectId)) continue;
    visualObjects[objectId] = scaleVisualObject(object, reframe);
    changed = true;
  }
  const propertyAnimations = scaleProjectPropertyAnimations(
    project,
    objectIds,
    skippedObjectIds,
    reframe,
  );
  if (propertyAnimations !== project.propertyAnimations) changed = true;
  return changed
    ? {
        ...project,
        visualObjects,
        ...(propertyAnimations === undefined ? {} : { propertyAnimations }),
      }
    : project;
}

/** True when the root composition has an active camera, which frames every clip and blocks Fit/Fill. */
export function canvasReframeIsCameraFramed(project: JoyProjectV1): boolean {
  const composition = project.compositions[project.rootCompositionId];
  return composition !== undefined && composition.activeCameraId !== undefined;
}

/**
 * Number of clip roots left alone: every clip root when a camera frames the
 * project, otherwise the roots whose transforms are not safely remappable.
 */
export function canvasReframeSkippedObjectCount(project: JoyProjectV1): number {
  const objectIds = collectCanvasReframeObjectIds(project);
  if (canvasReframeIsCameraFramed(project)) return objectIds.size;
  return collectCanvasReframeSkippedObjectIds(project, objectIds).size;
}

export function canvasReframeScale(
  source: CanvasSize,
  target: CanvasSize,
  mode: Exclude<CanvasReframeMode, 'keep'>,
): number | undefined {
  return canvasReframeTransform(source, target, mode)?.scaleX;
}

function canvasReframeTransform(
  source: CanvasSize,
  target: CanvasSize,
  mode: Exclude<CanvasReframeMode, 'keep'>,
): MediaFitTransform | undefined {
  if (
    ![source.width, source.height, target.width, target.height].every(
      (value) => Number.isFinite(value) && value > 0,
    )
  )
    return undefined;
  return calculateMediaFitTransform({
    sourceWidth: source.width,
    sourceHeight: source.height,
    frameWidth: target.width,
    frameHeight: target.height,
    mode,
  });
}

function scaleVisualObject(object: VisualObjectV1, reframe: MediaFitTransform): VisualObjectV1 {
  const transform = object.transform;
  const scale = reframe.scaleX;
  const mapX = (value: number) => reframe.x + value * scale;
  const mapY = (value: number) => reframe.y + value * scale;
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
    ...(spatialPath === undefined
      ? {}
      : { spatialPath: scaleSpatialPath(spatialPath, mapX, mapY, scale) }),
  };
}

function collectCanvasReframeObjectIds(project: JoyProjectV1): Set<string> {
  const composition = project.compositions[project.rootCompositionId];
  if (composition === undefined) return new Set();
  const clipIds = new Set(
    composition.tracks.flatMap((track) => track.clips.map((clip) => clip.id)),
  );
  const boundObjectIds = Object.entries(readClipObjectIdsMap(project))
    .filter(([clipId]) => clipIds.has(clipId))
    .flatMap(([, objectIds]) => objectIds);
  const roots = new Set<string>();

  // Transforms are parent-local: remap each safe parentless root once, then let descendants inherit it.
  for (const objectId of boundObjectIds) {
    const rootId = findParentlessRoot(objectId, project.visualObjects);
    if (rootId !== undefined) roots.add(rootId);
  }
  return roots;
}

function findParentlessRoot(
  objectId: string,
  objects: JoyProjectV1['visualObjects'],
): string | undefined {
  let current: VisualObjectV1 | undefined = objects[objectId];
  const visited = new Set<string>();
  while (current !== undefined) {
    if (current.parentId === undefined) return current.id;
    if (visited.has(current.id)) return undefined;
    visited.add(current.id);
    current = objects[current.parentId];
  }
  return undefined;
}

function isTransformExpressionDriven(object: VisualObjectV1): boolean {
  return (
    object.expressions?.x !== undefined ||
    object.expressions?.y !== undefined ||
    object.expressions?.scaleX !== undefined ||
    object.expressions?.scaleY !== undefined
  );
}

function collectCanvasReframeSkippedObjectIds(
  project: JoyProjectV1,
  objectIds: ReadonlySet<string>,
): Set<string> {
  const skipped = new Set<string>();
  for (const objectId of objectIds) {
    const object = project.visualObjects[objectId];
    if (object !== undefined && isTransformExpressionDriven(object)) skipped.add(objectId);
  }
  for (const animation of Object.values(project.propertyAnimations ?? {})) {
    const { ownerKind, ownerId } = animation.binding;
    if (
      ownerKind === 'visual-object' &&
      objectIds.has(ownerId) &&
      !isSafelyRemappablePropertyAnimation(animation)
    )
      skipped.add(ownerId);
  }
  return skipped;
}

function isSafelyRemappablePropertyAnimation(animation: PropertyAnimationV2): boolean {
  const { propertyId } = animation.binding;
  if (
    propertyId === 'x' ||
    propertyId === 'y' ||
    propertyId === 'scaleX' ||
    propertyId === 'scaleY'
  )
    return animation.value.kind === 'scalar';
  if (propertyId === 'visual.transform.position' || propertyId === 'visual.transform.scale')
    return animation.value.kind === 'vector';
  return true;
}

function scaleProjectPropertyAnimations(
  project: JoyProjectV1,
  objectIds: ReadonlySet<string>,
  skippedObjectIds: ReadonlySet<string>,
  reframe: MediaFitTransform,
): JoyProjectV1['propertyAnimations'] {
  const current = project.propertyAnimations;
  if (current === undefined) return current;
  const scale = reframe.scaleX;
  const mapX = (value: number) => reframe.x + value * scale;
  const mapY = (value: number) => reframe.y + value * scale;
  let changed = false;
  const next: Record<string, PropertyAnimationV2> = { ...current };
  for (const [key, animation] of Object.entries(current)) {
    const { ownerKind, ownerId, propertyId } = animation.binding;
    if (ownerKind !== 'visual-object' || !objectIds.has(ownerId) || skippedObjectIds.has(ownerId))
      continue;
    const nextAnimation = scalePropertyAnimation(animation, propertyId, mapX, mapY, scale);
    if (nextAnimation === animation) continue;
    next[key] = nextAnimation;
    changed = true;
  }
  return changed ? next : current;
}

function scalePropertyAnimation(
  animation: PropertyAnimationV2,
  propertyId: string,
  mapX: (value: number) => number,
  mapY: (value: number) => number,
  scale: number,
): PropertyAnimationV2 {
  const value = animation.value;
  if (
    (propertyId === 'x' ||
      propertyId === 'y' ||
      propertyId === 'scaleX' ||
      propertyId === 'scaleY') &&
    value.kind === 'scalar'
  ) {
    return {
      ...animation,
      value: {
        ...value,
        curve: scaleAnimation(value.curve, propertyId, mapX, mapY, scale),
      },
    };
  }
  if (propertyId === 'visual.transform.position' && value.kind === 'vector') {
    return {
      ...animation,
      value: {
        ...value,
        curve: {
          ...value.curve,
          ...(value.curve.x === undefined
            ? {}
            : { x: scaleAnimation(value.curve.x, 'x', mapX, mapY, scale) }),
          ...(value.curve.y === undefined
            ? {}
            : { y: scaleAnimation(value.curve.y, 'y', mapX, mapY, scale) }),
        },
      },
    };
  }
  if (propertyId === 'visual.transform.scale' && value.kind === 'vector') {
    return {
      ...animation,
      value: {
        ...value,
        curve: {
          ...value.curve,
          ...(value.curve.scaleX === undefined
            ? {}
            : { scaleX: scaleAnimation(value.curve.scaleX, 'scaleX', mapX, mapY, scale) }),
          ...(value.curve.scaleY === undefined
            ? {}
            : { scaleY: scaleAnimation(value.curve.scaleY, 'scaleY', mapX, mapY, scale) }),
        },
      },
    };
  }
  return animation;
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
