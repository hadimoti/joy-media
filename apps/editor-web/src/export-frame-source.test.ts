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

const fake = vi.hoisted(() => ({
  track: undefined as { canDecode(): Promise<boolean> } | null | undefined,
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
  fake.track = { canDecode: async () => true };
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
  it('hands the clip back to the seeking path when it has no video track', async () => {
    fake.track = null;
    expect(await openExportFrameSource(new Blob([]), 'asset-a')).toBeUndefined();
    expect(fake.inputDisposed).toBe(1);
  });

  it('hands the clip back when the browser cannot decode its codec', async () => {
    fake.track = { canDecode: async () => false };
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
