import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openExportFrameSource } from './export-frame-source.js';

interface FakeSample {
  readonly timestamp: number;
  readonly microsecondTimestamp: number;
  readonly displayWidth: number;
  readonly displayHeight: number;
  draw(...args: unknown[]): void;
  close(): void;
}

interface FakeTrack {
  canDecode(): Promise<boolean>;
  getTimeResolution(): Promise<number>;
  computePacketStats(packetCount: number): Promise<{ readonly averagePacketRate: number }>;
}

const fake = vi.hoisted(() => ({
  track: undefined as FakeTrack | null | undefined,
  timeResolution: 15_360,
  packetTicks: [0, 512, 1024, 1536] as number[],
  packetsFail: false,
  onResolutionRead: undefined as (() => void) | undefined,
  samples: undefined as ((startSec: number) => AsyncIterator<unknown>) | undefined,
  inputDisposed: 0,
  log: [] as string[],
}));

vi.mock('mediabunny', () => ({
  ALL_FORMATS: [],
  BlobSource: class {},
  Input: class {
    async getPrimaryVideoTrack() {
      return fake.track;
    }
    dispose() {
      fake.inputDisposed += 1;
    }
  },
  EncodedPacketSink: class {
    packets() {
      return (async function* () {
        for (const ticks of fake.packetTicks) {
          if (fake.packetsFail) throw new Error('packets unreadable');
          // Packet times in seconds, on the MP4 fixture's 1/15360 grid, as the demuxer reports them.
          yield { timestamp: ticks / 15_360 };
        }
      })();
    }
  },
  VideoSampleSink: class {
    samples(startSec: number) {
      return fake.samples!(startSec);
    }
  },
}));

function sampleAt(microseconds: number, size = { width: 1080, height: 1920 }): FakeSample {
  return {
    timestamp: microseconds / 1_000_000,
    microsecondTimestamp: microseconds,
    displayWidth: size.width,
    displayHeight: size.height,
    draw: () => fake.log.push(`draw:${microseconds}`),
    close: () => fake.log.push(`close:${microseconds}`),
  };
}

/** A decoder that yields the given frames, starting from the one on screen at `startSec`. */
function framesFrom(timesUs: readonly number[]): (startSec: number) => AsyncIterator<unknown> {
  return (startSec) => {
    let index = 0;
    while (index + 1 < timesUs.length && timesUs[index + 1]! <= startSec * 1_000_000) index += 1;
    return {
      next: async () => {
        const time = timesUs[index];
        if (time === undefined) return { done: true, value: undefined };
        index += 1;
        return { done: false, value: sampleAt(time) };
      },
      return: async () => ({ done: true, value: undefined }),
    };
  };
}

const canvas = { width: 0, height: 0, getContext: () => context };
const context = {
  clearRect: () => fake.log.push('clearRect'),
  getImageData: (_x: number, _y: number, width: number, height: number) => {
    fake.log.push('getImageData');
    return { width, height, data: new Uint8ClampedArray(4) };
  },
};

beforeEach(() => {
  fake.packetTicks = [0, 512, 1024, 1536];
  fake.packetsFail = false;
  fake.onResolutionRead = undefined;
  fake.track = {
    canDecode: async () => true,
    getTimeResolution: async () => fake.timeResolution,
    computePacketStats: async () => ({ averagePacketRate: 30 }),
  };
  fake.timeResolution = 15_360;
  fake.samples = framesFrom([0, 41_667, 83_333, 125_000]);
  fake.inputDisposed = 0;
  fake.log = [];
  canvas.width = 0;
  canvas.height = 0;
  vi.stubGlobal('document', { createElement: () => canvas });
  vi.stubGlobal('VideoDecoder', class {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('openExportFrameSource', () => {
  it('shows a WebM frame at its millisecond-rounded time, but an MP4 frame only at its exact time', async () => {
    // Frame times as the containers store them: WebM rounds to whole milliseconds (the third
    // frame at 30 fps is at 66.67 ms, stored as 67 ms); MP4 keeps the truncated microsecond time.
    // The tolerance follows each container's own resolution: 1000 for WebM, 15360 for the C7 MP4.
    const timesUs = [0, 33_000, 67_000, 100_000];
    fake.samples = framesFrom(timesUs);
    fake.timeResolution = 1000;
    const webm = await openExportFrameSource(new Blob([]), 'webm-asset');
    await webm?.frameAt(66_666, 1);
    expect(fake.log).toContain('draw:67000');
    webm?.close();

    fake.log = [];
    fake.samples = framesFrom(timesUs);
    fake.timeResolution = 15_360;
    const mp4 = await openExportFrameSource(new Blob([]), 'mp4-asset');
    await mp4?.frameAt(66_666, 1);
    expect(fake.log).toContain('draw:33000');
    expect(fake.log).not.toContain('draw:67000');
    mp4?.close();
  });

  it('reports the frame timing that the seek fallback aims with', async () => {
    fake.timeResolution = 1000;
    const source = await openExportFrameSource(new Blob([]), 'asset-a');
    expect(source?.seekTiming?.frameDurationUs).toBeCloseTo(1_000_000 / 30, 3);
    expect(source?.seekTiming?.toleranceUs).toBeCloseTo(500, 6);
    // The stored frame times are the ones the forward lookup compares: each packet time rounded to
    // the 1000 resolution (WebM style), then truncated to microseconds, in ascending order.
    expect(source?.seekTiming?.storedFrameUs).toEqual([0, 33_000, 67_000, 100_000]);
    source?.close();
  });

  it('stays on the seeking path when the stored frame times cannot be read', async () => {
    // The forward decoder and the seek fallback must agree frame for frame, so a clip without its
    // stored frame times is not decoded forward at all.
    fake.packetsFail = true;
    const source = await openExportFrameSource(new Blob([]), 'asset-a');
    expect(source).toBeUndefined();
    expect(fake.inputDisposed).toBe(1);
  });

  it('stays on the seeking path when the track cannot report its resolution', async () => {
    // Without a resolution there is no table to normalise against.
    fake.track = {
      canDecode: async () => true,
      getTimeResolution: async () => {
        throw new Error('no resolution');
      },
      computePacketStats: async () => ({ averagePacketRate: 30 }),
    };
    fake.samples = framesFrom([0, 33_333]);
    expect(await openExportFrameSource(new Blob([]), 'asset-a')).toBeUndefined();
  });

  it('throws an AbortError, not a source, when cancelled while the resolution is read', async () => {
    // Abort only once the resolution read has started, so the stall is what the cancel interrupts.
    const started = new Promise<void>((resolve) => {
      fake.onResolutionRead = resolve;
    });
    fake.track = {
      canDecode: async () => true,
      getTimeResolution: () => {
        fake.onResolutionRead?.();
        return new Promise<number>(() => undefined);
      },
      computePacketStats: async () => ({ averagePacketRate: 30 }),
    };
    const controller = new AbortController();
    const pending = openExportFrameSource(new Blob([]), 'asset-a', { signal: controller.signal });
    await started;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    // The input is released once, by the cancelled open.
    expect(fake.inputDisposed).toBe(1);
  });

  it('throws an AbortError when cancelled while the codec check never settles', async () => {
    fake.track = {
      canDecode: () => new Promise<boolean>(() => undefined),
      getTimeResolution: async () => fake.timeResolution,
      computePacketStats: async () => ({ averagePacketRate: 30 }),
    };
    const controller = new AbortController();
    const pending = openExportFrameSource(new Blob([]), 'asset-a', { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fake.inputDisposed).toBe(1);
  });

  it('throws an AbortError, not undefined, when the codec check answers false after a cancel', async () => {
    const controller = new AbortController();
    fake.track = {
      canDecode: async () => {
        controller.abort();
        return false;
      },
      getTimeResolution: async () => fake.timeResolution,
      computePacketStats: async () => ({ averagePacketRate: 30 }),
    };
    await expect(
      openExportFrameSource(new Blob([]), 'asset-a', { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('throws an AbortError on a browser without WebCodecs when the export is already cancelled', async () => {
    vi.stubGlobal('VideoDecoder', undefined);
    const controller = new AbortController();
    controller.abort();
    await expect(
      openExportFrameSource(new Blob([]), 'asset-a', { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('throws an AbortError when the export is cancelled before the forward open starts', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      openExportFrameSource(new Blob([]), 'asset-a', { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('hands the clip back to the seeking path when it has no video track', async () => {
    fake.track = null;
    expect(await openExportFrameSource(new Blob([]), 'asset-a')).toBeUndefined();
    expect(fake.inputDisposed).toBe(1);
  });

  it('hands the clip back when the browser cannot decode its codec', async () => {
    fake.track = {
      canDecode: async () => false,
      getTimeResolution: async () => fake.timeResolution,
      computePacketStats: async () => ({ averagePacketRate: 30 }),
    };
    expect(await openExportFrameSource(new Blob([]), 'asset-a')).toBeUndefined();
    expect(fake.inputDisposed).toBe(1);
  });

  it('does nothing without WebCodecs', async () => {
    vi.stubGlobal('VideoDecoder', undefined);
    expect(await openExportFrameSource(new Blob([]), 'asset-a')).toBeUndefined();
  });

  it('clears the canvas, draws the frame, and only then reads the pixels', async () => {
    const source = await openExportFrameSource(new Blob([]), 'asset-a');
    const frame = await source?.frameAt(0, 7);
    expect(fake.log.slice(0, 3)).toEqual(['clearRect', 'draw:0', 'getImageData']);
    expect(frame).toMatchObject({
      assetId: 'asset-a',
      sourceTimeUs: 0,
      token: 'html-media:7',
      bitmap: { width: 1080, height: 1920 },
    });
    // The size is the display size, after rotation.
    expect(source?.size()).toEqual({ width: 1080, height: 1920 });
  });

  it('serves the frame on screen at the requested time and closes the ones it moved past', async () => {
    const source = await openExportFrameSource(new Blob([]), 'asset-a');
    await source?.frameAt(0, 1);
    await source?.frameAt(50_000, 2);
    expect(fake.log.filter((entry) => entry.startsWith('draw:'))).toEqual(['draw:0', 'draw:41667']);
    expect(fake.log).toContain('close:0');
    source?.close();
    expect(fake.log).toContain('close:41667');
    expect(fake.inputDisposed).toBe(1);
  });

  it('resizes the canvas when the frame size changes', async () => {
    fake.samples = (startSec) => {
      const sizes = [sampleAt(0, { width: 640, height: 360 }), sampleAt(100_000)];
      let index = startSec >= 0.1 ? 1 : 0;
      return {
        next: async () => {
          const value = sizes[index++];
          return value === undefined ? { done: true, value: undefined } : { done: false, value };
        },
        return: async () => ({ done: true, value: undefined }),
      };
    };
    const source = await openExportFrameSource(new Blob([]), 'asset-a');
    await source?.frameAt(0, 1);
    expect(source?.size()).toEqual({ width: 640, height: 360 });
    await source?.frameAt(100_000, 2);
    expect(source?.size()).toEqual({ width: 1080, height: 1920 });
  });

  it('falls back, once and with a warning, when the decoder fails after opening', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let opened = 0;
    fake.samples = () => {
      opened += 1;
      return {
        next: async () => {
          throw new Error('decoder rejected the stream');
        },
        return: async () => ({ done: true, value: undefined }),
      };
    };
    const source = await openExportFrameSource(new Blob([]), 'asset-a');
    expect(await source?.frameAt(0, 1)).toBeUndefined();
    expect(await source?.frameAt(33_333, 2)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(opened).toBe(1);
  });

  it('gives up on a decoder that stalls, stops it, and hands the clip back', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fake.samples = () => ({
      next: () => new Promise(() => undefined),
      return: async () => ({ done: true, value: undefined }),
    });
    const source = await openExportFrameSource(new Blob([]), 'asset-a', { decodeTimeoutMs: 25 });
    expect(await source?.frameAt(0, 1)).toBeUndefined();
    expect(fake.inputDisposed).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    // Later requests do not touch the stopped decoder.
    expect(await source?.frameAt(33_333, 2)).toBeUndefined();
  });

  it('stops a stalled decoder at once when the export is cancelled', async () => {
    fake.samples = () => ({
      next: () => new Promise(() => undefined),
      return: async () => ({ done: true, value: undefined }),
    });
    const source = await openExportFrameSource(new Blob([]), 'asset-a');
    const controller = new AbortController();
    const pending = source?.frameAt(0, 1, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fake.inputDisposed).toBe(1);
  });

  it('rejects straight away when the export was already cancelled', async () => {
    const source = await openExportFrameSource(new Blob([]), 'asset-a');
    const controller = new AbortController();
    controller.abort();
    await expect(source?.frameAt(0, 1, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(fake.inputDisposed).toBe(1);
  });

  it('closes a frame that is still being decoded when the source is closed', async () => {
    let finishDecoding: (() => void) | undefined;
    fake.samples = () => ({
      next: () =>
        new Promise((resolve) => {
          finishDecoding = () => resolve({ done: false, value: sampleAt(0) });
        }),
      return: async () => ({ done: true, value: undefined }),
    });
    const source = await openExportFrameSource(new Blob([]), 'asset-a');
    const pending = source?.frameAt(0, 1);
    source?.close();
    finishDecoding?.();
    expect(await pending).toBeUndefined();
    expect(fake.log).toContain('close:0');
  });
});
