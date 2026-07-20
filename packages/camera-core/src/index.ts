/**
 * @joy-media/camera-core — depth-only 2.5D camera projection (WP-10.1, ADR-0015).
 *
 * A pure perspective camera composed on top of motion-core's parenting. No
 * yaw/pitch, no per-layer 3D tilt — see the package README and ADR-0015.
 * Dependency points inward (§9.1): camera-core → motion-core → project-schema.
 */

export const PACKAGE_NAME = '@joy-media/camera-core' as const;

export type { CameraParamsV1 } from '@joy-media/project-schema';

export type { CameraParams } from './projection.js';
export { focalLengthPx, projectThroughCamera } from './projection.js';

export {
  CameraSceneError,
  resolveCameraParams,
  resolveObjectTransformThroughCamera,
  worldDepth,
} from './scene.js';
