import type { Composition } from '@joy-media/project-schema';

/**
 * The ids of the clips that sit on a hidden track (the eye button sets the track's \`enabled\` to false). A text or
 * sticker is a visual object bound to such a clip, so the picture and the export use this set to leave it out.
 */
export function hiddenClipIds(project: {
  readonly compositions: Readonly<Record<string, Composition>>;
}): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const composition of Object.values(project.compositions)) {
    for (const track of composition.tracks) {
      if (track.enabled !== false) continue;
      for (const clip of track.clips) ids.add(clip.id);
    }
  }
  return ids;
}
