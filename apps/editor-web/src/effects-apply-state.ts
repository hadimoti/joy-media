import type { SpikeProject } from '@joy-media/project-schema';

/** Effects can only mutate one concrete video clip at a time. */
export function isSingleVideoClipSelected(
  timelineProject: SpikeProject,
  selectedClipIds: readonly string[],
): boolean {
  if (selectedClipIds.length !== 1) return false;
  const selectedClipId = selectedClipIds[0];
  const root = timelineProject.compositions[timelineProject.rootCompositionId];
  return (
    root?.tracks.some((track) =>
      track.clips.some((clip) => clip.id === selectedClipId && clip.kind === 'video'),
    ) ?? false
  );
}
