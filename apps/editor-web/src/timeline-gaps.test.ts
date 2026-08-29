import { describe, expect, it } from 'vitest';
import { timelineGapsForClips } from './timeline-gaps.js';

describe('timelineGapsForClips', () => {
  it('finds interior gaps in time order even when clips are unsorted', () => {
    expect(
      timelineGapsForClips([
        { startUs: 22_800_000, durationUs: 5_000_000 },
        { startUs: 2_500_000, durationUs: 10_000_000 },
      ]),
    ).toEqual([{ startUs: 12_500_000, endUs: 22_800_000, durationUs: 10_300_000 }]);
  });

  it('merges overlaps and ignores sub-frame gaps', () => {
    expect(
      timelineGapsForClips([
        { startUs: 0, durationUs: 2_000_000 },
        { startUs: 1_500_000, durationUs: 1_000_000 },
        { startUs: 2_050_000, durationUs: 1_000_000 },
      ]),
    ).toEqual([]);
  });

  it('does not create a gap for a single clip or invalid spans', () => {
    expect(
      timelineGapsForClips([
        { startUs: 0, durationUs: 0 },
        { startUs: Number.NaN, durationUs: 1_000_000 },
        { startUs: 1_000_000, durationUs: 2_000_000 },
      ]),
    ).toEqual([]);
  });
});
