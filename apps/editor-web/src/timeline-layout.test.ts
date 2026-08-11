import { describe, expect, it } from 'vitest';
import {
  TIMELINE_END_PADDING_PX,
  TIMELINE_TRACK_GUTTER_WIDTH_PX,
  timelineContentWidthPx,
  timelineEffectiveDurationUs,
  timelineFollowScrollLeft,
  timelineMinWidthStyle,
  timelineOriginStyle,
} from './timeline-layout.js';

describe('timeline layout helpers', () => {
  it('keeps pixel measurements and CSS offsets on the exact 168px gutter', () => {
    expect(TIMELINE_TRACK_GUTTER_WIDTH_PX).toBe(168);
    expect(TIMELINE_END_PADDING_PX).toBe(24);
    expect(timelineContentWidthPx(1262.6)).toBeCloseTo(1094.6);
    expect(timelineMinWidthStyle(320)).toBe('calc(var(--timeline-track-gutter-width) + 320px)');
    expect(timelineOriginStyle(42)).toBe('calc(var(--timeline-track-gutter-width) + 42px)');
  });

  it('fits the authored content end when a clip exceeds the seeded composition duration', () => {
    expect(
      timelineEffectiveDurationUs({
        durationUs: 60_000_000,
        tracks: [{ clips: [{ startUs: 0, durationUs: 116_000_000 }] }],
      }),
    ).toBe(116_000_000);
    expect(
      timelineEffectiveDurationUs(
        { durationUs: 60_000_000, tracks: [{ clips: [] }] },
        [75_000_000],
      ),
    ).toBe(75_000_000);
  });

  it('follows the playhead to later pages and returns to zero after a loop', () => {
    expect(
      timelineFollowScrollLeft({
        scrollLeft: 0,
        clientWidth: 1_000,
        scrollWidth: 3_000,
        playheadContentX: 1_200,
      }),
    ).toBe(720);
    expect(
      timelineFollowScrollLeft({
        scrollLeft: 1_500,
        clientWidth: 1_000,
        scrollWidth: 3_000,
        playheadContentX: TIMELINE_TRACK_GUTTER_WIDTH_PX,
      }),
    ).toBe(0);
  });
});
