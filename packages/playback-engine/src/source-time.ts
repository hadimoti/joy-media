/** Maps a composition playhead to a media source time with end-exclusive clip ranges. */
export function sourceTimeAtPlayhead(
  clip: { readonly startUs: number; readonly durationUs: number; readonly sourceInUs: number },
  playheadUs: number,
): number | undefined {
  if (playheadUs < clip.startUs || playheadUs >= clip.startUs + clip.durationUs) return undefined;
  return clip.sourceInUs + (playheadUs - clip.startUs);
}
