import { describe, expect, it } from 'vitest';
import { runTimelineViewportBenchmark } from './index.js';

describe('@joy-media/benchmark', () => {
  it('uses the versioned scaled-down fixture while viewport work stays track-scoped', () => {
    const result = runTimelineViewportBenchmark();
    expect(result).toMatchObject({
      fixtureVersion: 1,
      profile: 'scaled-down',
      totalTracks: 10,
      totalClips: 1_000,
    });
    expect(result.visibleTrackIds).toEqual([
      'track-1',
      'track-2',
      'track-3',
      'track-4',
      'track-5',
      'track-6',
      'track-7',
    ]);
    const scrolled = runTimelineViewportBenchmark('scaled-down', 252, 180);
    expect(scrolled.visibleTrackIds).not.toEqual(result.visibleTrackIds);
    expect(scrolled.visibleTrackIds.length).toBeLessThanOrEqual(250);
  });
});
