import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeExportAudioWindow } from './export-audio-window.js';

interface CopyOptions {
  readonly planeIndex: number;
  readonly frameOffset?: number;
  readonly frameCount?: number;
}

/** A fake source of 60 s at 1 kHz, read in 100-frame samples like a real decoder would. */
const fake = vi.hoisted(() => {
  const state = {
    rate: 1_000,
    totalFrames: 60_000,
    framesPerSample: 100,
    track: undefined as { sampleRate: number; numberOfChannels: number } | null | undefined,
    requested: [] as Array<readonly [number, number]>,
    yielded: 0,
    closed: 0,
    disposed: 0,
    onYield: undefined as ((count: number) => void) | undefined,
    async *samples(startSec: number, endSec: number) {
      const startFrame = startSec * state.rate;
      const endFrame = Math.min(endSec * state.rate, state.totalFrames);
      for (
        let start = Math.floor(startFrame / state.framesPerSample) * state.framesPerSample;
        start < endFrame;
        start += state.framesPerSample
      ) {
        // Like a real sink, a sample that only starts before the request is still returned.
        if (start + state.framesPerSample <= startFrame) continue;
        state.yielded += 1;
        state.onYield?.(state.yielded);
        yield {
          timestamp: start / state.rate,
          numberOfFrames: state.framesPerSample,
          numberOfChannels: state.track?.numberOfChannels ?? 2,
          copyTo(destination: Float32Array, options: CopyOptions) {
            const from = options.frameOffset ?? 0;
            const count = options.frameCount ?? state.framesPerSample;
            for (let index = 0; index < count; index++) {
              const frame = start + from + index;
              destination[index] = options.planeIndex === 0 ? frame : -frame;
            }
          },
          close() {
            state.closed += 1;
          },
        };
      }
    },
  };
  return state;
});

vi.mock('mediabunny', () => ({
  ALL_FORMATS: [],
  BlobSource: class {},
  Input: class {
    async getPrimaryAudioTrack() {
      return fake.track;
    }
    dispose() {
      fake.disposed += 1;
    }
  },
  AudioSampleSink: class {
    samples(startSec: number, endSec: number) {
      fake.requested.push([startSec, endSec]);
      return fake.samples(startSec, endSec);
    }
  },
}));

type Clip = { sourceInUs: number; durationUs: number; playbackRate?: number; reversed?: boolean };

function decode(clip: Clip, signal: AbortSignal = new AbortController().signal) {
  return decodeExportAudioWindow({
    blob: new Blob([]),
    clip,
    outputSampleRate: fake.rate,
    label: 'Narration.wav',
    signal,
  });
}

beforeEach(() => {
  fake.track = { sampleRate: fake.rate, numberOfChannels: 2 };
  fake.requested = [];
  fake.yielded = 0;
  fake.closed = 0;
  fake.disposed = 0;
  fake.onYield = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('decodeExportAudioWindow', () => {
  it('resolves undefined, without reading samples, when the source has no audio track', async () => {
    fake.track = null;
    expect(await decode({ sourceInUs: 0, durationUs: 1_000_000 })).toBeUndefined();
    expect(fake.requested).toEqual([]);
    expect(fake.disposed).toBe(1);
  });

  it('refuses a source with more than two channels, with the message the export has always used', async () => {
    fake.track = { sampleRate: fake.rate, numberOfChannels: 3 };
    await expect(decode({ sourceInUs: 0, durationUs: 1_000_000 })).rejects.toThrow(
      'Export currently supports mono or stereo source audio',
    );
    expect(fake.requested).toEqual([]);
    expect(fake.disposed).toBe(1);
  });

  it('decodes only the window the clip plays, with each sample at its own source position', async () => {
    const result = await decode({ sourceInUs: 10_000_000, durationUs: 5_000_000 });
    // The clip reads source samples 10_000 to 15_000; the window adds two on each side.
    expect(result?.firstSample).toBe(9_998);
    expect(result?.sampleRate).toBe(fake.rate);
    expect(fake.requested).toHaveLength(1);
    expect(fake.requested[0]![0]).toBeCloseTo(9.998, 9);
    expect(fake.requested[0]![1]).toBeCloseTo(15.002, 9);
    const [left, right] = result!.channels;
    expect(left!.length).toBe(5_004);
    expect(right!.length).toBe(5_004);
    left!.forEach((value, index) => expect(value).toBe(9_998 + index));
    right!.forEach((value, index) => expect(value).toBe(-(9_998 + index)));
    expect(fake.closed).toBe(fake.yielded);
    expect(fake.disposed).toBe(1);
  });

  it('sizes its arrays to the window, not to the source', async () => {
    const result = await decode({ sourceInUs: 0, durationUs: 1_000_000 });
    expect(result!.channels[0]!.length).toBe(1_002);
    expect(result!.channels[0]!.length).toBeLessThan(fake.totalFrames);
    expect(fake.closed).toBe(fake.yielded);
  });

  it('stops between samples when the export is cancelled, and still closes the input', async () => {
    const controller = new AbortController();
    fake.onYield = (count) => {
      if (count === 2) controller.abort();
    };
    const error = await decode(
      { sourceInUs: 10_000_000, durationUs: 5_000_000 },
      controller.signal,
    ).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe('AbortError');
    expect(fake.yielded).toBe(2);
    expect(fake.disposed).toBe(1);
  });

  it('refuses a window longer than one hour, names the source, and reads nothing', async () => {
    await expect(decode({ sourceInUs: 0, durationUs: 3_600_500_000 })).rejects.toThrow(
      'Export audio window too long: 3601 s for Narration.wav',
    );
    expect(fake.requested).toEqual([]);
    expect(fake.disposed).toBe(1);
  });
});
