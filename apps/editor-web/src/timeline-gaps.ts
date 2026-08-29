export interface TimelineGap {
  readonly startUs: number;
  readonly endUs: number;
  readonly durationUs: number;
}

export interface TimelineClipSpan {
  readonly startUs: number;
  readonly durationUs: number;
}

/** Return meaningful interior gaps between clips on one track. */
export function timelineGapsForClips(
  clips: readonly TimelineClipSpan[],
  minimumGapUs = 100_000,
): TimelineGap[] {
  const ordered = clips
    .filter(
      (clip) =>
        Number.isFinite(clip.startUs) && Number.isFinite(clip.durationUs) && clip.durationUs > 0,
    )
    .map((clip) => ({ startUs: Math.max(0, clip.startUs), endUs: clip.startUs + clip.durationUs }))
    .sort((a, b) => a.startUs - b.startUs || a.endUs - b.endUs);

  const gaps: TimelineGap[] = [];
  if (ordered.length < 2) return gaps;

  let previousEndUs = ordered[0]!.endUs;
  for (const clip of ordered.slice(1)) {
    const startUs = Math.max(0, clip.startUs);
    if (startUs - previousEndUs >= minimumGapUs) {
      gaps.push({
        startUs: previousEndUs,
        endUs: startUs,
        durationUs: startUs - previousEndUs,
      });
    }
    previousEndUs = Math.max(previousEndUs, clip.endUs);
  }
  return gaps;
}
