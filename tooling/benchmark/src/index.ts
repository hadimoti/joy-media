import { createTimelineScaleFixture } from '@joy-media/test-fixtures';
import { virtualTracks } from '@joy-media/timeline-engine';

export interface TimelineBenchmarkResult {
  readonly fixtureVersion: 1;
  readonly profile: 'reference' | 'scaled-down';
  readonly totalTracks: number;
  readonly totalClips: number;
  readonly visibleTrackIds: readonly string[];
}

/**
 * Exercises viewport-only timeline work against a versioned fixture. Timings
 * are intentionally reported by a caller on named reference hardware rather
 * than asserted in CI.
 */
export function runTimelineViewportBenchmark(
  profile: 'reference' | 'scaled-down' = 'scaled-down',
  scrollTopPx = 72,
  viewportHeightPx = 180,
): TimelineBenchmarkResult {
  const fixture = createTimelineScaleFixture(profile);
  const visible = virtualTracks(fixture.tracks, scrollTopPx, viewportHeightPx);
  return {
    fixtureVersion: fixture.version,
    profile: fixture.profile,
    totalTracks: fixture.tracks.length,
    totalClips: fixture.clips.length,
    visibleTrackIds: visible.map((track) => track.id),
  };
}
