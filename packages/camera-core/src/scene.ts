/**
 * Composes camera-core's depth-only projection with motion-core's parent-chain
 * transform composition. This is the package's main entry point: resolving an
 * object's transform "through" a composition's active camera, or falling back
 * to plain parenting when there is none.
 */

import type { TimeUs, VisualObjectTransformV1, VisualObjectV1 } from '@joy-media/project-schema';
import { parentChain, resolveObjectTransform, resolveWorldTransform } from '@joy-media/motion-core';
import { projectThroughCamera, type CameraParams } from './projection.js';

export class CameraSceneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CameraSceneError';
  }
}

/**
 * An object's world depth (§20.3, ADR-0015): its own `positionZ` (default 0)
 * plus every ancestor's, additive down the parent chain — z is a translation
 * axis only, unaffected by 2D scale/rotation composition.
 */
export function worldDepth(
  objectId: string,
  objectsById: Readonly<Record<string, VisualObjectV1>>,
  timeUs: TimeUs,
): number {
  const object = objectsById[objectId];
  if (object === undefined) throw new CameraSceneError(`unknown visual object ${objectId}`);
  const chain: readonly VisualObjectV1[] = [object, ...parentChain(objectId, objectsById)];
  return chain.reduce(
    (sum, node) => sum + (resolveObjectTransform(node, timeUs).positionZ ?? 0),
    0,
  );
}

/** Resolves a `kind: 'camera'` object's world position/roll/FOV at `timeUs`. */
export function resolveCameraParams(
  cameraId: string,
  objectsById: Readonly<Record<string, VisualObjectV1>>,
  timeUs: TimeUs,
): CameraParams {
  const camera = objectsById[cameraId];
  if (camera === undefined) throw new CameraSceneError(`unknown camera ${cameraId}`);
  if (camera.kind !== 'camera') throw new CameraSceneError(`object "${cameraId}" is not a camera`);
  if (camera.camera === undefined)
    throw new CameraSceneError(`camera "${cameraId}" is missing camera params`);
  const world = resolveWorldTransform(cameraId, objectsById, timeUs);
  return {
    x: world.x,
    y: world.y,
    z: worldDepth(cameraId, objectsById, timeUs),
    rollDeg: world.rotationDeg,
    fieldOfViewDeg: camera.camera.fieldOfViewDeg,
  };
}

/**
 * An object's effective transform at `timeUs`, composed under its parent chain
 * and, when `cameraId` is given, projected through that camera. `cameraId`
 * undefined is the exact pre-P10 behavior (`resolveWorldTransform` alone) —
 * a composition with no `activeCameraId` is byte-for-byte unaffected.
 */
export function resolveObjectTransformThroughCamera(
  objectId: string,
  cameraId: string | undefined,
  objectsById: Readonly<Record<string, VisualObjectV1>>,
  timeUs: TimeUs,
  compHeight: number,
): VisualObjectTransformV1 {
  const world = resolveWorldTransform(objectId, objectsById, timeUs);
  if (cameraId === undefined) return world;
  const camera = resolveCameraParams(cameraId, objectsById, timeUs);
  const objectWorldZ = worldDepth(objectId, objectsById, timeUs);
  return projectThroughCamera(world, objectWorldZ, camera, compHeight);
}
