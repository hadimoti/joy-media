/** Shared geometry for every timeline surface. The CSS gutter is exactly this many px. */
export const TIMELINE_TRACK_GUTTER_WIDTH_PX = 168;

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
