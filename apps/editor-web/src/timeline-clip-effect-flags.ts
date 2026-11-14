import type { JoyProjectV1 } from '@joy-media/project-schema';
import { readClipObjectIdsMap } from './sticker-bindings.js';

/** What a timeline clip carries that its small icons should show. */
export interface ClipEffectFlags {
  /** An effect or filter sits on the clip's picture, or on a layer parented to it. */
  readonly effects: boolean;
  /** A transition starts or ends at this clip. */
  readonly transition: boolean;
}

export type ClipEffectFlagMap = Readonly<Record<string, ClipEffectFlags>>;

/**
 * For every clip that has an effect, a filter or a transition, say so. Clips with neither are left
 * out, so a plain clip shows no icon. Pure: reads the project only.
 */
export function computeClipEffectFlags(project: JoyProjectV1): ClipEffectFlagMap {
  const objects = project.visualObjects;
  const hasOwnEffects = (objectId: string): boolean =>
    (objects[objectId]?.effects?.length ?? 0) > 0;

  // object id -> ids of objects parented to it that carry effects (a filter layer on a clip).
  const effectLayersByParent = new Map<string, boolean>();
  for (const [objectId, object] of Object.entries(objects)) {
    if (object.parentId !== undefined && hasOwnEffects(objectId)) {
      effectLayersByParent.set(object.parentId, true);
    }
  }

  const transitionClipIds = new Set<string>();
  for (const transition of project.transitions ?? []) {
    transitionClipIds.add(transition.leftClipId);
    transitionClipIds.add(transition.rightClipId);
  }

  const out: Record<string, ClipEffectFlags> = {};
  const addFlags = (clipId: string, effects: boolean, transition: boolean) => {
    if (!effects && !transition) return;
    out[clipId] = { effects, transition };
  };
  const seen = new Set<string>();
  for (const [clipId, objectIds] of Object.entries(readClipObjectIdsMap(project))) {
    seen.add(clipId);
    const effects = objectIds.some(
      (objectId) => hasOwnEffects(objectId) || effectLayersByParent.get(objectId) === true,
    );
    addFlags(clipId, effects, transitionClipIds.has(clipId));
  }
  // A clip with a transition but no object binding still gets its transition icon.
  for (const clipId of transitionClipIds) {
    if (!seen.has(clipId)) addFlags(clipId, false, true);
  }
  return out;
}
