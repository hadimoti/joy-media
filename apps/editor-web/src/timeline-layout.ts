/** Shared geometry for every timeline surface. The CSS gutter is exactly this many px. */
export const TIMELINE_TRACK_GUTTER_WIDTH_PX = 168;
export const TIMELINE_END_PADDING_PX = 24;

/** The scoped CSS variable is defined as exactly 168px by `.timeline-panel`/`.dual-time`. */
export const TIMELINE_TRACK_GUTTER_CSS = 'var(--timeline-track-gutter-width)';

export function timelineContentWidthPx(scrollportWidthPx: number): number {
  return Math.max(0, scrollportWidthPx - TIMELINE_TRACK_GUTTER_WIDTH_PX);
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
}

/** Keep a playing playhead visible and return to the first page after a loop. */
export function timelineFollowScrollLeft(input: TimelineFollowScrollInput): number {
  const maxScroll = Math.max(0, input.scrollWidth - input.clientWidth);
  const current = Math.min(maxScroll, Math.max(0, input.scrollLeft));
  const leading = input.leadingPaddingPx ?? 32;
  const trailing = input.trailingPaddingPx ?? 80;
  const visibleLaneStart = current + TIMELINE_TRACK_GUTTER_WIDTH_PX + leading;
  const visibleEnd = current + input.clientWidth - trailing;
  const pageWidth = Math.max(
    1,
    input.clientWidth - TIMELINE_TRACK_GUTTER_WIDTH_PX - leading - trailing,
  );

  if (input.playheadContentX > visibleEnd) {
    const pages = Math.max(1, Math.ceil((input.playheadContentX - visibleEnd) / pageWidth));
    return Math.min(maxScroll, current + pages * pageWidth);
  }
  if (input.playheadContentX < visibleLaneStart) {
    return Math.min(
      maxScroll,
      Math.max(0, input.playheadContentX - TIMELINE_TRACK_GUTTER_WIDTH_PX - leading),
    );
  }
  return current;
}
