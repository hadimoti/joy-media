/**
 * Shared geometry for every timeline surface. The CSS gutter defaults to this
 * many px; the Timeline panel lets the user resize it and passes its own width
 * to the helpers below, every other surface keeps this default.
 */
export const TIMELINE_TRACK_GUTTER_WIDTH_PX = 168;
export const TIMELINE_TRACK_GUTTER_MIN_PX = 120;
export const TIMELINE_TRACK_GUTTER_MAX_PX = 420;
/** The track titles never take more than this share of the panel width. */
export const TIMELINE_TRACK_GUTTER_MAX_PANEL_FRACTION = 0.4;
export const TIMELINE_END_PADDING_PX = 24;
/**
 * An audio track header stacks its code, its name and one line of effect
 * chips: 13.8 + 13.8 + 2 + 17 px of content, a 1 px top border and breathing
 * room above and below. A shorter audio row clips the chips at its bottom edge.
 */
export const TIMELINE_AUDIO_TRACK_MIN_HEIGHT_PX = 56;

/** The scoped CSS variable defaults to 168px on `.timeline-panel`/`.dual-time`. */
export const TIMELINE_TRACK_GUTTER_CSS = 'var(--timeline-track-gutter-width)';

/** The widest track titles column a panel of this width allows. */
export function timelineTrackGutterMaxPx(panelWidthPx?: number): number {
  if (panelWidthPx === undefined || !Number.isFinite(panelWidthPx) || panelWidthPx <= 0) {
    return TIMELINE_TRACK_GUTTER_MAX_PX;
  }
  return Math.max(
    TIMELINE_TRACK_GUTTER_MIN_PX,
    Math.min(
      TIMELINE_TRACK_GUTTER_MAX_PX,
      Math.floor(panelWidthPx * TIMELINE_TRACK_GUTTER_MAX_PANEL_FRACTION),
    ),
  );
}

/** A track titles width inside the 120 px floor and the 420 px / 40 % ceiling. */
export function clampTimelineTrackGutterWidthPx(widthPx: number, panelWidthPx?: number): number {
  if (!Number.isFinite(widthPx)) return TIMELINE_TRACK_GUTTER_WIDTH_PX;
  return Math.round(
    Math.min(
      timelineTrackGutterMaxPx(panelWidthPx),
      Math.max(TIMELINE_TRACK_GUTTER_MIN_PX, widthPx),
    ),
  );
}

/** The drawn height of a track row: audio rows never shrink below their header content. */
export function timelineTrackRowHeightPx(track: {
  readonly family: 'visual' | 'audio';
  readonly heightPx: number;
}): number {
  return track.family === 'audio'
    ? Math.max(track.heightPx, TIMELINE_AUDIO_TRACK_MIN_HEIGHT_PX)
    : track.heightPx;
}

export function timelineContentWidthPx(
  scrollportWidthPx: number,
  gutterWidthPx: number = TIMELINE_TRACK_GUTTER_WIDTH_PX,
): number {
  return Math.max(0, scrollportWidthPx - gutterWidthPx);
}

export function timelineMinWidthStyle(laneWidthPx: number): string {
  return `calc(${TIMELINE_TRACK_GUTTER_CSS} + ${laneWidthPx}px)`;
}

export function timelineOriginStyle(timePx: number): string {
  return `calc(${TIMELINE_TRACK_GUTTER_CSS} + ${timePx}px)`;
}

export interface TimelineDurationComposition {
  readonly durationUs: number;
  readonly tracks: readonly {
    readonly clips: readonly { readonly startUs: number; readonly durationUs: number }[];
  }[];
}

/**
 * Visible/editor duration must never be shorter than authored content. Older
 * projects can retain the 60s seed duration after a longer clip is imported.
 */
export function timelineEffectiveDurationUs(
  composition: TimelineDurationComposition,
  markerTimesUs: readonly number[] = [],
): number {
  let endUs = Math.max(1, composition.durationUs);
  for (const track of composition.tracks) {
    for (const clip of track.clips) {
      endUs = Math.max(endUs, clip.startUs + clip.durationUs);
    }
  }
  for (const markerUs of markerTimesUs) endUs = Math.max(endUs, markerUs);
  return endUs;
}

export interface TimelineFollowScrollInput {
  readonly scrollLeft: number;
  readonly clientWidth: number;
  readonly scrollWidth: number;
  /** Playhead coordinate inside the complete scroll content, gutter included. */
  readonly playheadContentX: number;
  readonly leadingPaddingPx?: number;
  readonly trailingPaddingPx?: number;
  /** Track titles width; defaults to the 168 px gutter. */
  readonly gutterWidthPx?: number;
}

/** Keep a playing playhead visible and return to the first page after a loop. */
export function timelineFollowScrollLeft(input: TimelineFollowScrollInput): number {
  const maxScroll = Math.max(0, input.scrollWidth - input.clientWidth);
  const current = Math.min(maxScroll, Math.max(0, input.scrollLeft));
  const leading = input.leadingPaddingPx ?? 32;
  const trailing = input.trailingPaddingPx ?? 80;
  const gutter = input.gutterWidthPx ?? TIMELINE_TRACK_GUTTER_WIDTH_PX;
  const visibleLaneStart = current + gutter + leading;
  const visibleEnd = current + input.clientWidth - trailing;
  const pageWidth = Math.max(1, input.clientWidth - gutter - leading - trailing);

  if (input.playheadContentX > visibleEnd) {
    const pages = Math.max(1, Math.ceil((input.playheadContentX - visibleEnd) / pageWidth));
    return Math.min(maxScroll, current + pages * pageWidth);
  }
  if (input.playheadContentX < visibleLaneStart) {
    return Math.min(maxScroll, Math.max(0, input.playheadContentX - gutter - leading));
  }
  return current;
}
