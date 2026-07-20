/**
 * Depth-only 2.5D perspective camera (§20.3, ADR-0015). The camera always looks
 * straight down the +z axis — no yaw/pitch — so projection reduces to a
 * perspective divide on depth plus a 2D roll. A projected layer stays a flat
 * plane; this is deliberately *not* true 3D (no per-layer tilt, no oriented
 * quads), which is why the result fits back into the ordinary
 * `VisualObjectTransformV1` shape the renderer already understands.
 */

import type { VisualObjectTransformV1 } from '@joy-media/project-schema';

/** A camera's resolved world parameters at one instant. */
export interface CameraParams {
  readonly x: number;
  readonly y: number;
  /** World depth along the camera's view axis. */
  readonly z: number;
  /** 2D roll, degrees; composed with the projected layer's own rotation. */
  readonly rollDeg: number;
  /** Vertical field of view, degrees, in (0, 170]. */
  readonly fieldOfViewDeg: number;
}

/** Depth at which a layer projects at scale 1 for the given vertical FOV and composition height. */
export function focalLengthPx(fieldOfViewDeg: number, compHeight: number): number {
  const fovRad = (fieldOfViewDeg * Math.PI) / 180;
  return compHeight / 2 / Math.tan(fovRad / 2);
}

/**
 * A layer behind the camera or coincident with it has no well-defined
 * projection; clamping to this floor keeps the divide finite instead of
 * producing NaN/Infinity or a sign-flipped (behind-camera) result. There is no
 * culling in v1 — an out-of-range layer just projects at maximum foreshortening.
 */
const MIN_DEPTH_PX = 1e-3;

/**
 * Projects `world` (a layer's already parent-composed world transform, e.g.
 * from `resolveWorldTransform`) through `camera`, given the layer's own world
 * depth `worldZ` and the composition's pixel height (the FOV reference).
 * Depth is *not* copied to the result — the projected transform is 2D-only,
 * matching what the renderer consumes.
 */
export function projectThroughCamera(
  world: VisualObjectTransformV1,
  worldZ: number,
  camera: CameraParams,
  compHeight: number,
): VisualObjectTransformV1 {
  const focal = focalLengthPx(camera.fieldOfViewDeg, compHeight);
  const depth = Math.max(MIN_DEPTH_PX, worldZ - camera.z);
  const scale = focal / depth;
  const dx = (world.x - camera.x) * scale;
  const dy = (world.y - camera.y) * scale;
  const rollRad = (camera.rollDeg * Math.PI) / 180;
  const cos = Math.cos(rollRad);
  const sin = Math.sin(rollRad);
  return {
    ...world,
    x: dx * cos - dy * sin,
    y: dx * sin + dy * cos,
    scaleX: world.scaleX * scale,
    scaleY: world.scaleY * scale,
    rotationDeg: world.rotationDeg + camera.rollDeg,
  };
}
