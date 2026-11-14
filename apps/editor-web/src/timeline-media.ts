const MIN_FILMSTRIP_FRAMES = 2;
const MAX_FILMSTRIP_FRAMES = 24;
const FILMSTRIP_FRAME_SPACING_PX = 28;
/** A filmstrip tile is a small picture: 26 px wide and 2 px apart (the 28 px frame spacing), after the kind icon. */
export const FILMSTRIP_TILE_PX = 26;
export const FILMSTRIP_GAP_PX = 2;
export const FILMSTRIP_LEAD_PX = 30;
export const FILMSTRIP_TRAIL_PX = 4;

/** Whole tiles that fit in a clip of this width; a part that does not fit is hidden, never cut. */
export function visibleFilmstripTiles(widthPx: number): number {
  if (!Number.isFinite(widthPx)) return 0;
  const room = widthPx - FILMSTRIP_LEAD_PX - FILMSTRIP_TRAIL_PX + FILMSTRIP_GAP_PX;
  return Math.max(0, Math.floor(room / (FILMSTRIP_TILE_PX + FILMSTRIP_GAP_PX)));
}

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

/**
 * The part of a whole-file waveform that a trimmed clip plays: its source in-point to its source
 * out-point, flipped for a reversed clip. Without a known source length the peaks are returned as they are.
 */
export function sliceWaveformPeaks<T>(
  peaks: readonly T[],
  sourceDurationUs: number | undefined,
  options: Pick<
    FilmstripScheduleOptions,
    'sourceInUs' | 'durationUs' | 'playbackRate' | 'reversed'
  >,
): readonly T[] {
  if (sourceDurationUs === undefined || sourceDurationUs <= 0 || peaks.length === 0) return peaks;
  const rate = options.playbackRate ?? 1;
  const span = options.durationUs * (rate > 0 ? rate : 0);
  // A reversed clip plays from its in-point backwards.
  const fromUs = options.reversed === true ? options.sourceInUs - span : options.sourceInUs;
  const toUs = options.reversed === true ? options.sourceInUs : options.sourceInUs + span;
  const first = Math.max(
    0,
    Math.min(peaks.length - 1, Math.floor((fromUs / sourceDurationUs) * peaks.length)),
  );
  const last = Math.max(
    first + 1,
    Math.min(peaks.length, Math.ceil((toUs / sourceDurationUs) * peaks.length)),
  );
  const part = peaks.slice(first, last);
  return options.reversed === true ? [...part].reverse() : part;
}
