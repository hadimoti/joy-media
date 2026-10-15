/** Playback speed of a video clip (F2). The source span is kept; the timeline length changes. */
export const CLIP_SPEED_RANGE = { min: 0.1, max: 8 } as const;

export function clipSourceSpanUs(clip: {
  readonly durationUs: number;
  readonly playbackRate?: number | undefined;
}): number {
  const rate =
    typeof clip.playbackRate === 'number' && clip.playbackRate > 0 ? clip.playbackRate : 1;
  return Math.round(clip.durationUs * rate);
}

/** Timeline duration of the clip's current source span at `rate`. */
export function durationAtSpeedUs(
  clip: { readonly durationUs: number; readonly playbackRate?: number | undefined },
  rate: number,
): number {
  return Math.round(clipSourceSpanUs(clip) / rate);
}

export function speedProblem(rate: number): string | undefined {
  if (!Number.isFinite(rate) || rate < CLIP_SPEED_RANGE.min || rate > CLIP_SPEED_RANGE.max)
    return `Speed rate must be from ${CLIP_SPEED_RANGE.min} to ${CLIP_SPEED_RANGE.max} (2 = twice as fast, 0.5 = half speed).`;
  return undefined;
}
