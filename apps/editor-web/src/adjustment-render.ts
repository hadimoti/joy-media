import type { EffectInstanceV1, JoyProjectV1, SpikeProject } from '@joy-media/project-schema';
import { resolveObjectIdForSelection } from './sticker-bindings.js';
import { activeEffectLayerObjects, readEffectLayerTargetMap } from './timeline-element-kind.js';

/** Raw authored effects for a media clip, including active targeted controllers. */
export function effectInstancesForTimelineClip(
  project: JoyProjectV1,
  timeline: SpikeProject,
  clipId: string,
  timeUs: number,
): readonly EffectInstanceV1[] {
  const objectId = resolveObjectIdForSelection(project, [clipId]);
  const object = objectId === undefined ? undefined : project.visualObjects[objectId];
  return [
    ...(object?.effects ?? []),
    ...activeEffectLayerObjects(project, timeline, clipId, timeUs).flatMap(
      (controller) => controller.effects ?? [],
    ),
  ];
}

/**
 * Object renderer routing for pictures/shapes. Decoded video uses
 * {@link effectInstancesForTimelineClip} because its frame node is injected
 * after the visual-object frame is built.
 */
export function effectsByObjectIdAt(
  project: JoyProjectV1,
  timeline: SpikeProject,
  timeUs: number,
): Readonly<Record<string, readonly EffectInstanceV1[]>> {
  const map: Record<string, EffectInstanceV1[]> = {};
  for (const [objectId, object] of Object.entries(project.visualObjects)) {
    if (object.effects && object.effects.length > 0) map[objectId] = [...object.effects];
  }
  for (const targetClipId of new Set(Object.values(readEffectLayerTargetMap(project)))) {
    const targetObjectId = resolveObjectIdForSelection(project, [targetClipId]);
    if (targetObjectId === undefined) continue;
    const layerEffects = activeEffectLayerObjects(project, timeline, targetClipId, timeUs).flatMap(
      (object) => object.effects ?? [],
    );
    if (layerEffects.length > 0) {
      map[targetObjectId] = [...(map[targetObjectId] ?? []), ...layerEffects];
    }
  }
  return map;
}
