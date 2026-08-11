import type { Composition, SpikeProject } from '@joy-media/project-schema';
import { timelineEffectiveDurationUs } from './timeline-layout.js';

/** Root-coordinate conversion for an editable nested/compound timeline view. */
export interface TimelineCompositionView {
  readonly composition: Composition;
  /** Root time where this composition's local time 0 begins. */
  readonly rootOffsetUs: number;
  /** Parent composition ids, root first and the active composition last. */
  readonly path: readonly string[];
}

function findView(
  project: SpikeProject,
  compositionId: string,
  rootOffsetUs: number,
  path: readonly string[],
  targetId: string,
  visiting: ReadonlySet<string>,
): TimelineCompositionView | undefined {
  const composition = project.compositions[compositionId];
  if (composition === undefined) return undefined;
  if (compositionId === targetId) return { composition, rootOffsetUs, path };
  for (const track of composition.tracks) {
    for (const clip of track.clips) {
      if (clip.kind !== 'composition' || visiting.has(clip.compositionId)) continue;
      const child = project.compositions[clip.compositionId];
      if (child === undefined) continue;
      const found = findView(
        project,
        child.id,
        rootOffsetUs + clip.startUs - clip.childOffsetUs,
        [...path, child.id],
        targetId,
        new Set([...visiting, child.id]),
      );
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** Resolve a nested composition to its root timeline offset and ancestry. */
export function timelineCompositionView(
  project: SpikeProject,
  compositionId: string,
): TimelineCompositionView | undefined {
  return findView(
    project,
    project.rootCompositionId,
    0,
    [project.rootCompositionId],
    compositionId,
    new Set([project.rootCompositionId]),
  );
}

/** Convert an authoritative root playhead into a clamped active-view time. */
export function timelineViewLocalTime(view: TimelineCompositionView, rootTimeUs: number): number {
  return Math.max(
    0,
    Math.min(timelineEffectiveDurationUs(view.composition), rootTimeUs - view.rootOffsetUs),
  );
}

/** Convert an active-view time back to the authoritative root playhead. */
export function timelineViewRootTime(view: TimelineCompositionView, localTimeUs: number): number {
  return (
    view.rootOffsetUs +
    Math.max(0, Math.min(timelineEffectiveDurationUs(view.composition), localTimeUs))
  );
}
