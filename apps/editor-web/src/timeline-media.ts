const MIN_FILMSTRIP_FRAMES = 2;
const MAX_FILMSTRIP_FRAMES = 24;
const FILMSTRIP_FRAME_SPACING_PX = 28;

export interface FilmstripScheduleOptions {
  readonly sourceInUs: number;
  readonly durationUs: number;
  readonly pixelsPerSecond: number;
  readonly playbackRate?: number;
  readonly reversed?: boolean;
}

export interface TimelineElementMediaSource extends Omit<
  FilmstripScheduleOptions,
  'pixelsPerSecond'
> {
  readonly assetId: string;
}

/**
 * Source timestamps for a clip's filmstrip at its current zoom. The first
 * sample is always the clip's source in-point; reverse and freeze playback use
 * the same time mapping as the clip itself.
 */
export function scheduleFilmstripFrameTimes({
  sourceInUs,
  durationUs,
  pixelsPerSecond,
  playbackRate = 1,
  reversed = false,
}: FilmstripScheduleOptions): readonly number[] {
  if (
    !Number.isFinite(sourceInUs) ||
    sourceInUs < 0 ||
    !Number.isFinite(durationUs) ||
    durationUs <= 0 ||
    !Number.isFinite(pixelsPerSecond) ||
    pixelsPerSecond <= 0 ||
    !Number.isFinite(playbackRate) ||
    playbackRate < 0
  )
    return [];

  const widthPx = (durationUs * pixelsPerSecond) / 1_000_000;
  const count = Math.max(
    MIN_FILMSTRIP_FRAMES,
    Math.min(MAX_FILMSTRIP_FRAMES, Math.floor(widthPx / FILMSTRIP_FRAME_SPACING_PX)),
  );
  return Array.from({ length: count }, (_, index) => {
    const timelineOffsetUs = (durationUs * index) / (count - 1);
    const sourceDeltaUs = Math.round(timelineOffsetUs * playbackRate);
    const sourceUs = reversed ? sourceInUs - sourceDeltaUs : sourceInUs + sourceDeltaUs;
    return Math.max(0, Math.round(sourceUs));
  });
}
