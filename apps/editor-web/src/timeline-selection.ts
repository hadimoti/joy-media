import type { SpikeProject } from '@joy-media/project-schema';

/**
 * Remove clip selections that no longer exist after Undo, Redo, or a history
 * jump. Keeping a deleted id selected produces ghost labels in Inspector and
 * can route later commands to a target that is no longer on any timeline.
 */
export function reconcileTimelineSelection(
  project: SpikeProject,
  selectedIds: readonly string[],
): readonly string[] {
  const liveClipIds = new Set(
    Object.values(project.compositions).flatMap((composition) =>
      composition.tracks.flatMap((track) => track.clips.map((clip) => clip.id)),
    ),
  );
  return selectedIds.filter((id) => liveClipIds.has(id));
}
