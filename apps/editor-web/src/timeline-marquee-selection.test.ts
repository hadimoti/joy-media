import { describe, expect, it } from 'vitest';
import {
  hasExceededMarqueeThreshold,
  normalizeTimelineRect,
  timelineRectsIntersect,
  unionTimelineSelection,
} from './timeline-marquee-selection.js';

describe('timeline marquee geometry', () => {
  it('normalizes every drag direction', () => {
    expect(normalizeTimelineRect({ x: 20, y: 30 }, { x: 5, y: 10 })).toEqual({
      left: 5,
      top: 10,
      right: 20,
      bottom: 30,
    });
    expect(normalizeTimelineRect({ x: 5, y: 10 }, { x: 20, y: 30 })).toEqual({
      left: 5,
      top: 10,
      right: 20,
      bottom: 30,
    });
  });

  it('uses inclusive intersection at the visible edge', () => {
    const selection = normalizeTimelineRect({ x: 10, y: 10 }, { x: 20, y: 20 });
    expect(timelineRectsIntersect(selection, { left: 20, top: 5, right: 30, bottom: 15 })).toBe(
      true,
    );
    expect(timelineRectsIntersect(selection, { left: 21, top: 5, right: 30, bottom: 15 })).toBe(
      false,
    );
  });

  it('promotes only at the configured threshold', () => {
    expect(hasExceededMarqueeThreshold({ x: 0, y: 0 }, { x: 3, y: 0 })).toBe(false);
    expect(hasExceededMarqueeThreshold({ x: 0, y: 0 }, { x: 4, y: 0 })).toBe(true);
    expect(hasExceededMarqueeThreshold({ x: 0, y: 0 }, { x: -3, y: -3 })).toBe(true);
  });

  it('replaces or adds to the pointer-down baseline', () => {
    expect(unionTimelineSelection(['a', 'b'], ['c', 'a'], false)).toEqual(['c', 'a']);
    expect(unionTimelineSelection(['a', 'b'], ['c', 'a'], true)).toEqual(['a', 'b', 'c']);
  });
});
