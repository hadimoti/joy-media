import { describe, expect, it } from 'vitest';
import {
  TIMELINE_AUDIO_TRACK_MIN_HEIGHT_PX,
  TIMELINE_END_PADDING_PX,
  TIMELINE_TRACK_GUTTER_MAX_PX,
  TIMELINE_TRACK_GUTTER_MIN_PX,
  TIMELINE_TRACK_GUTTER_WIDTH_PX,
  clampTimelineTrackGutterWidthPx,
  timelineContentWidthPx,
  timelineEffectiveDurationUs,
  timelineFollowScrollLeft,
  timelineMinWidthStyle,
  timelineOriginStyle,
  timelineTrackGutterMaxPx,
  timelineTrackRowHeightPx,
} from './timeline-layout.js';

describe('timeline layout helpers', () => {
  it('keeps pixel measurements and CSS offsets on the exact 168px gutter', () => {
    expect(TIMELINE_TRACK_GUTTER_WIDTH_PX).toBe(168);
    expect(TIMELINE_END_PADDING_PX).toBe(24);
    expect(timelineContentWidthPx(1262.6)).toBeCloseTo(1094.6);
    expect(timelineMinWidthStyle(320)).toBe('calc(var(--timeline-track-gutter-width) + 320px)');
    expect(timelineOriginStyle(42)).toBe('calc(var(--timeline-track-gutter-width) + 42px)');
  });

  it('measures with a resized gutter and keeps it inside 120 px and 420 px or 40 percent', () => {
    expect(timelineContentWidthPx(1_000, 240)).toBe(760);
    expect(timelineContentWidthPx(100, 240)).toBe(0);
    expect(clampTimelineTrackGutterWidthPx(90)).toBe(TIMELINE_TRACK_GUTTER_MIN_PX);
    expect(clampTimelineTrackGutterWidthPx(900)).toBe(TIMELINE_TRACK_GUTTER_MAX_PX);
    expect(clampTimelineTrackGutterWidthPx(900, 700)).toBe(280);
    expect(clampTimelineTrackGutterWidthPx(200, 200)).toBe(TIMELINE_TRACK_GUTTER_MIN_PX);
    expect(clampTimelineTrackGutterWidthPx(Number.NaN)).toBe(TIMELINE_TRACK_GUTTER_WIDTH_PX);
    expect(timelineTrackGutterMaxPx(2_000)).toBe(420);
    expect(timelineTrackGutterMaxPx(500)).toBe(200);
  });

  it('follows the playhead past a resized gutter', () => {
    // Playhead behind the lane start of a 260 px gutter: scroll back so it shows 32 px in.
    expect(
      timelineFollowScrollLeft({
        scrollLeft: 1_500,
        clientWidth: 1_000,
        scrollWidth: 3_000,
        playheadContentX: 1_750,
        gutterWidthPx: 260,
      }),
    ).toBe(1_458);
    // The same playhead is already visible past the default 168 px gutter.
    expect(
      timelineFollowScrollLeft({
        scrollLeft: 1_500,
        clientWidth: 1_000,
        scrollWidth: 3_000,
        playheadContentX: 1_750,
      }),
    ).toBe(1_500);
  });

  it('keeps audio rows tall enough for their header content', () => {
    expect(TIMELINE_AUDIO_TRACK_MIN_HEIGHT_PX).toBe(56);
    expect(timelineTrackRowHeightPx({ family: 'audio', heightPx: 44 })).toBe(56);
    expect(timelineTrackRowHeightPx({ family: 'audio', heightPx: 80 })).toBe(80);
    expect(timelineTrackRowHeightPx({ family: 'visual', heightPx: 44 })).toBe(44);
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
