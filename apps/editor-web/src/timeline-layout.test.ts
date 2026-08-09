import { describe, expect, it } from 'vitest';
import {
  TIMELINE_TRACK_GUTTER_WIDTH_PX,
  timelineContentWidthPx,
  timelineMinWidthStyle,
  timelineOriginStyle,
} from './timeline-layout.js';

describe('timeline layout helpers', () => {
  it('keeps pixel measurements and CSS offsets on the exact 168px gutter', () => {
    expect(TIMELINE_TRACK_GUTTER_WIDTH_PX).toBe(168);
    expect(timelineContentWidthPx(1262.6)).toBeCloseTo(1094.6);
    expect(timelineMinWidthStyle(320)).toBe('calc(var(--timeline-track-gutter-width) + 320px)');
    expect(timelineOriginStyle(42)).toBe('calc(var(--timeline-track-gutter-width) + 42px)');
  });
});
