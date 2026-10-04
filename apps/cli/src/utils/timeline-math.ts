import type { JoyProjectV1 } from '@joy-media/project-schema';

/** Fit the root composition to the latest clip extent, with a one-second floor. */
export function recomputeRootDuration(project: JoyProjectV1): number {
  const root = project.compositions[project.rootCompositionId];
  if (!root) return 1_000_000;
  const latestEnd = root.tracks.reduce(
    (maximum, track) =>
      track.clips.reduce(
        (trackMaximum, clip) => Math.max(trackMaximum, clip.startUs + clip.durationUs),
        maximum,
      ),
    0,
  );
  const durationUs = Math.max(1_000_000, latestEnd);
  (root as unknown as { durationUs: number }).durationUs = durationUs;
  return durationUs;
}
