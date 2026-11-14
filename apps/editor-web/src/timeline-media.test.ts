import { describe, expect, it, vi } from 'vitest';
import {
  clearTimelineMediaCaches,
  getCachedFilmstripFrames,
  getCachedWaveformPeaks,
} from './timeline-media-cache.js';
import {
  scheduleFilmstripFrameTimes,
  sliceWaveformPeaks,
  visibleFilmstripTiles,
} from './timeline-media.js';

describe('timeline media scheduling', () => {
  it('starts at the source in-point and spaces frames across the clip at the current zoom', () => {
    expect(
      scheduleFilmstripFrameTimes({
        sourceInUs: 1_000_000,
        durationUs: 2_000_000,
        pixelsPerSecond: 56,
      }),
    ).toEqual([1_000_000, 1_666_667, 2_333_333, 3_000_000]);
  });

  it('maps filmstrip samples through playback rate and reverse direction', () => {
    expect(
      scheduleFilmstripFrameTimes({
        sourceInUs: 5_000_000,
        durationUs: 2_000_000,
        pixelsPerSecond: 42,
        playbackRate: 2,
        reversed: true,
      }),
    ).toEqual([5_000_000, 3_000_000, 1_000_000]);
  });

  it('reuses the held source frame for a freeze clip', () => {
    expect(
      scheduleFilmstripFrameTimes({
        sourceInUs: 750_000,
        durationUs: 10_000_000,
        pixelsPerSecond: 5,
        playbackRate: 0,
      }),
    ).toEqual([750_000, 750_000]);
  });

  it('bounds frame count for very wide and narrow clips', () => {
    expect(
      scheduleFilmstripFrameTimes({
        sourceInUs: 0,
        durationUs: 1_000_000,
        pixelsPerSecond: 1,
      }),
    ).toHaveLength(2);
    expect(
      scheduleFilmstripFrameTimes({
        sourceInUs: 0,
        durationUs: 60_000_000,
        pixelsPerSecond: 1_000,
      }),
    ).toHaveLength(24);
  });

  it('reuses cached filmstrip frames for the same asset and source timestamps', async () => {
    clearTimelineMediaCaches();
    const decode = vi.fn(
      async (times: readonly number[]) => new Map(times.map((time) => [time, `frame-${time}`])),
    );

    const first = await getCachedFilmstripFrames('asset-a', [0, 1_000_000], decode);
    const second = await getCachedFilmstripFrames('asset-a', [1_000_000, 0], decode);

    expect(first.get(0)).toBe('frame-0');
    expect(second.get(1_000_000)).toBe('frame-1000000');
    expect(decode).toHaveBeenCalledOnce();
  });

  it('shares the waveform peak promise and cached peak data per asset', async () => {
    clearTimelineMediaCaches();
    const peaks = [{ min: -0.5, max: 0.75 }];
    const decode = vi.fn(async () => peaks);

    expect(await getCachedWaveformPeaks('asset-a', decode)).toBe(peaks);
    expect(await getCachedWaveformPeaks('asset-a', decode)).toBe(peaks);
    expect(decode).toHaveBeenCalledOnce();
  });
});

describe('filmstrip tiles', () => {
  it('shows only whole tiles and hides them all when the clip is too short', () => {
    expect(visibleFilmstripTiles(20)).toBe(0);
    expect(visibleFilmstripTiles(60)).toBe(1);
    expect(visibleFilmstripTiles(30 + 4 + 26 * 3 + 2 * 2)).toBe(3);
    expect(visibleFilmstripTiles(30 + 4 + 26 * 3 + 2 * 2 - 1)).toBe(2);
    expect(visibleFilmstripTiles(Number.NaN)).toBe(0);
  });
});

describe('waveform slice', () => {
  const peaks = Array.from({ length: 100 }, (_, index) => index);
  it('keeps only the part a trimmed clip plays', () => {
    const part = sliceWaveformPeaks(peaks, 60_000_000, {
      sourceInUs: 12_000_000,
      durationUs: 6_000_000,
    });
    expect(part[0]).toBe(20);
    expect(part.length).toBe(10);
  });
  it('flips a reversed clip and scales by speed', () => {
    const part = sliceWaveformPeaks(peaks, 60_000_000, {
      sourceInUs: 30_000_000,
      durationUs: 5_000_000,
      playbackRate: 2,
      reversed: true,
    });
    expect(part[0]).toBeGreaterThan(part[part.length - 1]!);
    expect(part.length).toBe(17);
  });
  it('returns the peaks unchanged when the source length is unknown', () => {
    expect(sliceWaveformPeaks(peaks, undefined, { sourceInUs: 1, durationUs: 1 })).toBe(peaks);
  });
});
