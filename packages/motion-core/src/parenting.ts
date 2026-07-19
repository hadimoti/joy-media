/**
 * Parenting / null-object evaluation (§20.3, §39-65). A child inherits its
 * parent's transform: the child's local transform is composed under the parent's
 * *world* transform, walking up the chain to the root. Null objects (kind
 * `'null'`) render nothing but still contribute a transform here — they are pure
 * controllers. All math is 2D TRS composition; crop stays object-local.
 */

import type { TimeUs, VisualObjectTransformV1, VisualObjectV1 } from '@joy-media/project-schema';
import { resolveObjectTransform } from './transform.js';

/** Composes a child's local transform under its parent's world transform. */
export function composeTransforms(
  parentWorld: VisualObjectTransformV1,
  local: VisualObjectTransformV1,
): VisualObjectTransformV1 {
  const radians = (parentWorld.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const scaledX = parentWorld.scaleX * local.x;
  const scaledY = parentWorld.scaleY * local.y;
  return {
    x: parentWorld.x + scaledX * cos - scaledY * sin,
    y: parentWorld.y + scaledX * sin + scaledY * cos,
    scaleX: parentWorld.scaleX * local.scaleX,
    scaleY: parentWorld.scaleY * local.scaleY,
    rotationDeg: parentWorld.rotationDeg + local.rotationDeg,
    opacity: parentWorld.opacity * local.opacity,
    crop: local.crop,
  };
}

/**
 * The ancestor chain from `objectId` up to the root, nearest parent first. A
 * cycle (only reachable in untrusted data — the schema rejects cycles) is broken
 * at its first repeat so evaluation can never loop forever.
 */
export function parentChain(
  objectId: string,
  objectsById: Readonly<Record<string, VisualObjectV1>>,
): readonly VisualObjectV1[] {
  const chain: VisualObjectV1[] = [];
  const seen = new Set<string>([objectId]);
  let current = objectsById[objectId]?.parentId;
  while (current !== undefined) {
    if (seen.has(current)) break;
    const parent = objectsById[current];
    if (parent === undefined) break;
    chain.push(parent);
    seen.add(current);
    current = parent.parentId;
  }
  return chain;
}

/**
 * The object's world transform at `timeUs`: its animated local transform
 * composed under every ancestor's animated transform. `resolveLocal` defaults to
 * the keyframe-aware local resolver, but is injectable for testing.
 */
export function resolveWorldTransform(
  objectId: string,
  objectsById: Readonly<Record<string, VisualObjectV1>>,
  timeUs: TimeUs,
  resolveLocal: (
    object: VisualObjectV1,
    timeUs: TimeUs,
  ) => VisualObjectTransformV1 = resolveObjectTransform,
): VisualObjectTransformV1 {
  const object = objectsById[objectId];
  if (object === undefined) throw new RangeError(`unknown visual object ${objectId}`);
  // Ancestors are nearest-first; compose from the root down to this object.
  const ancestors = parentChain(objectId, objectsById);
  let world: VisualObjectTransformV1 | undefined;
  for (let i = ancestors.length - 1; i >= 0; i -= 1) {
    const local = resolveLocal(ancestors[i]!, timeUs);
    world = world === undefined ? local : composeTransforms(world, local);
  }
  const local = resolveLocal(object, timeUs);
  return world === undefined ? local : composeTransforms(world, local);
}
