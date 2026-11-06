import { describe, expect, it } from 'vitest';
import {
  frameCentreSeekUs,
  frameTimesOf,
  frameTimingOf,
  seekUsForSource,
  storedFrameCentreSeekUs,
  timestampToleranceUs,
} from './export-seek-target.js';

/** Stored WebM times at 30 fps: whole milliseconds, rounded to the nearest (C8 and C9 fixtures). */
const WEBM_30_STORED_US = Array.from({ length: 180 }, (_, k) => Math.round((k * 100) / 3) * 1000);

/** Packets with presentation times in seconds, as mediabunny's packets carry them. */
async function* packetsOf(seconds: readonly number[]) {
  for (const timestamp of seconds) yield { timestamp };
}

const FRAME_30 = 1_000_000 / 30;
/** The frame index a seek target lands in. */
const frameOf = (targetUs: number, frameUs: number): number => Math.floor(targetUs / frameUs);

describe('frameCentreSeekUs', () => {
  it('aims at the middle of the frame that holds the source time', () => {
    expect(frameCentreSeekUs(0, FRAME_30)).toBeCloseTo(FRAME_30 / 2, 6);
    expect(frameOf(frameCentreSeekUs(5_000_000, FRAME_30), FRAME_30)).toBe(150);
  });

  it('keeps a time just short of a frame edge in the earlier frame', () => {
    const edge = 179 * FRAME_30;
    expect(frameOf(frameCentreSeekUs(edge - 1.33, FRAME_30), FRAME_30)).toBe(178);
    expect(frameOf(frameCentreSeekUs(edge - 0.67, FRAME_30), FRAME_30)).toBe(178);
  });

  it('keeps a time exactly on a frame edge in the frame that starts there', () => {
    expect(frameOf(frameCentreSeekUs(179 * FRAME_30, FRAME_30), FRAME_30)).toBe(179);
  });

  it('stays in the first frame for a negative time', () => {
    expect(frameCentreSeekUs(-500, FRAME_30)).toBeCloseTo(FRAME_30 / 2, 6);
  });

  it('gives the reversed export sequence its intended frames', () => {
    // Clip B reversed: its in-point is the last sample (5 999 999 µs), and output frame n after the
    // cut reads 1 frame less than the one before, as the export computes it.
    for (let n = 180; n <= 359; n++) {
      const playheadUs = Math.round((n * 1_000_000) / 30);
      const sourceUs = 5_999_999 - (playheadUs - 6_000_000);
      expect(frameOf(frameCentreSeekUs(sourceUs, FRAME_30), FRAME_30)).toBe(359 - n);
    }
  });

  it('applies the timestamp tolerance, so a time just before a stored frame edge keeps the later frame', () => {
    // Output frame 2 at 30 fps starts at 66.67 ms; the WebM source stores that frame at 67 ms.
    expect(frameOf(frameCentreSeekUs(66_666, FRAME_30, 500), FRAME_30)).toBe(2);
    // Without a tolerance the same time lands in frame 1, which is the repeat the export showed.
    expect(frameOf(frameCentreSeekUs(66_666, FRAME_30), FRAME_30)).toBe(1);
  });

  it('lands on the same frame as the forward lookup for every output frame of the WebM timeline', () => {
    // Stored times of a 1/1000 time base at 30 fps (ffprobe on the C8 and C9 fixtures).
    const storedUs = Array.from(
      { length: 180 },
      (_, index) => Math.round((index * 100) / 3) * 1000,
    );
    for (let n = 0; n < 180; n++) {
      const sourceUs = Math.floor((n * 1_000_000) / 30);
      const target = frameCentreSeekUs(sourceUs, FRAME_30, timestampToleranceUs(1000));
      // The frame on screen at the seek target is the last one stored at or before it.
      let onScreen = 0;
      storedUs.forEach((timestamp, index) => {
        if (timestamp <= target) onScreen = index;
      });
      expect(onScreen).toBe(n);
    }
  });
});

/** The frame the forward lookup shows at `timeUs`: the last one stored at or before it plus tolerance. */
function forwardFrameIndex(
  storedUs: readonly number[],
  timeUs: number,
  toleranceUs: number,
): number {
  let index = 0;
  storedUs.forEach((timestamp, k) => {
    if (timestamp <= timeUs + toleranceUs) index = k;
  });
  return index;
}

describe('the seek fallback and the forward lookup on the output grid', () => {
  for (const fps of [24, 25, 30, 50, 60]) {
    it(`show the same source frame for every output frame at ${fps} fps, on a 1/1000 WebM timeline`, () => {
      const frameUs = 1_000_000 / fps;
      const count = Math.round(6 * fps);
      // Stored times are whole milliseconds, rounded to the nearest, as WebM stores them.
      const storedUs = Array.from(
        { length: count },
        (_, k) => Math.round((k * frameUs) / 1000) * 1000,
      );
      const tolerance = timestampToleranceUs(1000);
      for (let n = 0; n < count; n++) {
        const sourceUs = Math.floor((n * 1_000_000) / fps);
        const seekIndex = Math.floor(frameCentreSeekUs(sourceUs, frameUs, tolerance) / frameUs);
        expect(seekIndex).toBe(n);
        expect(forwardFrameIndex(storedUs, sourceUs, tolerance)).toBe(n);
      }
    });
  }

  it('documents the one place they can differ: a time off the output grid, just before a stored edge', () => {
    // At 30 fps frame 2 starts at 66.67 ms but is stored at 67 ms. A request at 66.3 ms is inside
    // the window 66.17 to 66.50 ms, where the forward lookup (stored times) keeps frame 1 and the
    // seek (nominal times) aims at frame 2. The output grid never lands there, so this only matters
    // for off-grid source times at the handover from the forward decoder to seeking.
    const frameUs = 1_000_000 / 30;
    const storedUs = [0, 33_000, 67_000, 100_000];
    const tolerance = timestampToleranceUs(1000);
    expect(forwardFrameIndex(storedUs, 66_300, tolerance)).toBe(1);
    expect(Math.floor(frameCentreSeekUs(66_300, frameUs, tolerance) / frameUs)).toBe(2);
  });
});

describe('frameTimingOf', () => {
  it('reports the frame length from the packet rate, with the given tolerance', async () => {
    const timing = await frameTimingOf(
      { computePacketStats: async () => ({ averagePacketRate: 25 }) },
      500,
    );
    expect(timing).toEqual({ frameDurationUs: 40_000, toleranceUs: 500 });
  });

  it('is undefined when the rate is unknown or cannot be read', async () => {
    expect(
      await frameTimingOf({ computePacketStats: async () => ({ averagePacketRate: 0 }) }, 0),
    ).toBeUndefined();
    expect(
      await frameTimingOf(
        {
          computePacketStats: async () => {
            throw new Error('unreadable');
          },
        },
        0,
      ),
    ).toBeUndefined();
  });
});

describe('timestampToleranceUs', () => {
  it('is half a storage unit of the container timescale', () => {
    expect(timestampToleranceUs(1000)).toBe(500);
    expect(timestampToleranceUs(15_360)).toBeCloseTo(32.55, 2);
  });

  it('is zero when the resolution is unknown', () => {
    expect(timestampToleranceUs(0)).toBe(0);
  });
});

describe('storedFrameCentreSeekUs', () => {
  it('lands in the stored frame the forward lookup shows, for every output frame', () => {
    for (let n = 0; n < 180; n++) {
      const sourceUs = Math.floor((n * 1_000_000) / 30);
      const target = storedFrameCentreSeekUs(sourceUs, WEBM_30_STORED_US, FRAME_30, 500);
      expect(forwardFrameIndex(WEBM_30_STORED_US, target, 0)).toBe(n);
    }
  });

  it('agrees with the forward lookup for source times anywhere on the timeline, on or off the output grid', () => {
    // A step of 997 us is not a divisor of the 33,333 us frame, so most samples are off the grid.
    for (let sourceUs = 0; sourceUs <= 6_000_000; sourceUs += 997) {
      const target = storedFrameCentreSeekUs(sourceUs, WEBM_30_STORED_US, FRAME_30, 500);
      expect(forwardFrameIndex(WEBM_30_STORED_US, target, 0)).toBe(
        forwardFrameIndex(WEBM_30_STORED_US, sourceUs, 500),
      );
    }
  });

  it('aims at the first frame for a time before it', () => {
    expect(storedFrameCentreSeekUs(-500, WEBM_30_STORED_US, FRAME_30, 500)).toBeCloseTo(16_500, 6);
  });
});

describe('frameTimesOf', () => {
  it('collects every frame time in microseconds, ascending', async () => {
    const times = await frameTimesOf(() => packetsOf([0.067, 0, 0.033]), 1000);
    expect(times).toEqual([0, 33_000, 67_000]);
  });

  it('rounds packet times to the track resolution first, as the decoder does', async () => {
    // A laced packet at 33.333 ms is decoded at 33 ms (1/1000 resolution), so the table has 33 ms.
    const times = await frameTimesOf(() => packetsOf([0.033333]), 1000);
    expect(times).toEqual([33_000]);
    // And the seek for a time 0.5 ms before that frame stays in the frame before, as the lookup does.
    const stored = [0, 33_000, 67_000];
    expect(forwardFrameIndex(stored, 32_500, 500)).toBe(1);
    const target = storedFrameCentreSeekUs(32_500, stored, FRAME_30, 500);
    expect(forwardFrameIndex(stored, target, 0)).toBe(1);
  });

  it('is undefined when the packets cannot be read, none are found, the resolution is unknown, or the export is cancelled', async () => {
    async function* failing() {
      yield { timestamp: 0 };
      throw new Error('unreadable');
    }
    expect(await frameTimesOf(() => failing(), 1000)).toBeUndefined();
    expect(await frameTimesOf(() => packetsOf([]), 1000)).toBeUndefined();
    expect(await frameTimesOf(() => packetsOf([0, 0.033]), 0)).toBeUndefined();
    const cancelled = new AbortController();
    cancelled.abort();
    expect(await frameTimesOf(() => packetsOf([0, 0.033]), 1000, cancelled.signal)).toBeUndefined();
    expect(
      await frameTimesOf(() => {
        throw new Error('cannot open');
      }, 1000),
    ).toBeUndefined();
  });
});

describe('frame times at a high timescale', () => {
  it('converts a tick the way the Chromium decoder path does (the packet time, rounded, truncated)', async () => {
    // Tick 30,005 at 900 kHz is 33.3389 ms: 33,338 us.
    expect(
      await frameTimesOf(() => packetsOf([30_005 / 900_000]), 900_000, undefined, false),
    ).toEqual([33_338]);
  });

  it('converts a tick the way the WebKit decoder path does (truncated to microseconds first)', async () => {
    // The WebKit path first truncates to 33,338 us, which rounds to 33,337 us at 900 kHz.
    expect(
      await frameTimesOf(() => packetsOf([30_005 / 900_000]), 900_000, undefined, true),
    ).toEqual([33_337]);
  });
});

describe('cancellation during the one-off reads', () => {
  it('stops waiting on a packet read that never settles once the export is cancelled', async () => {
    const stalled: AsyncIterable<{ readonly timestamp: number }> = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<{ readonly timestamp: number }>>(() => undefined),
        return: async () => ({ done: true, value: undefined }),
      }),
    };
    const controller = new AbortController();
    const pending = frameTimesOf(() => stalled, 1000, controller.signal);
    controller.abort();
    await expect(pending).resolves.toBeUndefined();
  });

  it('stops waiting on a statistics read that never settles once the export is cancelled', async () => {
    const controller = new AbortController();
    const pending = frameTimingOf(
      { computePacketStats: () => new Promise<never>(() => undefined) },
      0,
      controller.signal,
    );
    controller.abort();
    await expect(pending).resolves.toBeUndefined();
  });

  it('returns at once when the export was already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      frameTimingOf(
        { computePacketStats: () => new Promise<never>(() => undefined) },
        0,
        controller.signal,
      ),
    ).resolves.toBeUndefined();
  });
});

describe('seekUsForSource', () => {
  it('seeks to the exact time when there is no frame timing', () => {
    expect(seekUsForSource(66_666, undefined)).toBe(66_666);
  });

  it('uses the stored frames when they are known, and the nominal frames otherwise', () => {
    const timing = { frameDurationUs: FRAME_30, toleranceUs: 500 };
    expect(seekUsForSource(66_666, { ...timing, storedFrameUs: WEBM_30_STORED_US })).toBe(
      storedFrameCentreSeekUs(66_666, WEBM_30_STORED_US, FRAME_30, 500),
    );
    expect(seekUsForSource(66_666, timing)).toBe(frameCentreSeekUs(66_666, FRAME_30, 500));
  });
});
