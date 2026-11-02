import { describe, expect, it, vi } from 'vitest';
import { createOfflineAacTrack, type OfflineAacTrackDeps } from './offline-aac-track.js';
import type { Output } from 'mediabunny';

interface CapturedSample {
  readonly init: {
    readonly data: Float32Array;
    readonly format: 'f32-planar';
    readonly numberOfChannels: number;
    readonly sampleRate: number;
    readonly timestamp: number;
  };
  closed: boolean;
}

interface FakeSource {
  readonly adds: CapturedSample[];
  closeCount: number;
  add(sample: unknown): Promise<void>;
  close(): void;
}

function makeHarness(options?: {
  add?: (sample: CapturedSample) => Promise<void>;
  close?: () => void;
}) {
  const samples: CapturedSample[] = [];
  const sources: FakeSource[] = [];
  const addedTracks: FakeSource[] = [];
  const deps: OfflineAacTrackDeps = {
    createAudioSample: (init) => {
      const sample: CapturedSample = { init, closed: false };
      samples.push(sample);
      return {
        close: () => {
          sample.closed = true;
        },
      };
    },
    createAudioSampleSource: (config) => {
      expect(config).toEqual({ codec: 'aac', bitrate: 128_000 });
      const source: FakeSource = {
        adds: [],
        closeCount: 0,
        add: async (sample) => {
          const captured = sample as CapturedSample;
          source.adds.push(captured);
          await options?.add?.(captured);
        },
        close: () => {
          source.closeCount += 1;
          options?.close?.();
        },
      };
      sources.push(source);
      return source;
    },
  };
  const output = {
    addAudioTrack: (source: FakeSource) => {
      addedTracks.push(source);
    },
  };
  return { deps, samples, sources, addedTracks, output };
}

function audioOptions(
  sampleRate: number,
  durationSamples: number,
  channelData: Float32Array[] = [],
) {
  return {
    channelData,
    sampleRate,
    durationUs: (durationSamples * 1_000_000) / sampleRate,
  };
}

describe('createOfflineAacTrack', () => {
  it.each([
    { sampleRate: 4, durationUs: 1_250_000, expected: 5 },
    { sampleRate: 10, durationUs: 250_000, expected: 3 },
    { sampleRate: 8, durationUs: 62_499, expected: 0 },
    { sampleRate: 3, durationUs: 500_000, expected: 2 },
  ])(
    'feeds exactly the rounded composition length ($sampleRate Hz)',
    async ({ sampleRate, durationUs, expected }) => {
      const harness = makeHarness();
      const track = createOfflineAacTrack(
        { channelData: [], sampleRate, durationUs },
        harness.deps,
      );

      await track.finish();

      expect(harness.samples.reduce((sum, sample) => sum + sample.init.data.length / 2, 0)).toBe(
        expected,
      );
      expect(
        harness.samples
          .flatMap((sample) => Array.from(sample.init.data))
          .every((value) => value === 0),
      ).toBe(true);
    },
  );

  it('pads short input with silence and cuts long input to the composition length', async () => {
    const padded = makeHarness();
    const paddingTrack = createOfflineAacTrack(
      audioOptions(10, 5, [new Float32Array([0.25]), new Float32Array([-0.25])]),
      padded.deps,
    );
    await paddingTrack.finish();
    expect(Array.from(padded.samples[0]!.init.data)).toEqual([0.25, 0, 0, 0, 0, -0.25, 0, 0, 0, 0]);

    const cut = makeHarness();
    const cuttingTrack = createOfflineAacTrack(
      audioOptions(4, 2, [new Float32Array([1, 2, 3]), new Float32Array([4, 5, 6])]),
      cut.deps,
    );
    await cuttingTrack.finish();
    expect(Array.from(cut.samples[0]!.init.data)).toEqual([1, 2, 4, 5]);
  });

  it('duplicates mono input into the two planar output channels', async () => {
    const harness = makeHarness();
    const track = createOfflineAacTrack(
      audioOptions(4, 3, [new Float32Array([0.1, 0.2, 0.3])]),
      harness.deps,
    );

    await track.finish();

    expect(Array.from(harness.samples[0]!.init.data)).toEqual(
      Array.from(new Float32Array([0.1, 0.2, 0.3, 0.1, 0.2, 0.3])),
    );
    expect(harness.samples[0]!.init).toMatchObject({ format: 'f32-planar', numberOfChannels: 2 });
  });

  it('chunks at one second and uses exact sample-based timestamps', async () => {
    const harness = makeHarness();
    const track = createOfflineAacTrack(audioOptions(4, 10), harness.deps);

    await track.finish();

    expect(harness.samples.map((sample) => sample.init.data.length / 2)).toEqual([4, 4, 2]);
    expect(harness.samples.map((sample) => sample.init.timestamp)).toEqual([0, 1, 2]);
  });

  it('feeds only chunk starts before the requested time and never repeats chunks', async () => {
    const harness = makeHarness();
    const track = createOfflineAacTrack(audioOptions(4, 12), harness.deps);

    await track.feedUntil(1);
    expect(harness.samples.map((sample) => sample.init.timestamp)).toEqual([0]);
    await track.feedUntil(2.5);
    await track.feedUntil(2.5);
    expect(harness.samples.map((sample) => sample.init.timestamp)).toEqual([0, 1, 2]);
  });

  it('finish adds remaining chunks once, closes the source, and is idempotent', async () => {
    const harness = makeHarness();
    const track = createOfflineAacTrack(audioOptions(4, 10), harness.deps);
    track.attach(harness.output as unknown as Output);
    await track.feedUntil(1.5);
    await track.finish();
    await track.finish();

    expect(harness.addedTracks).toEqual(harness.sources);
    expect(harness.samples.map((sample) => sample.init.timestamp)).toEqual([0, 1, 2]);
    expect(harness.sources[0]!.closeCount).toBe(1);
    expect(harness.samples.every((sample) => sample.closed)).toBe(true);
  });

  it('closes every sample when source.add rejects and propagates the rejection', async () => {
    const failure = new Error('encoder failed');
    const harness = makeHarness({ add: async () => Promise.reject(failure) });
    const track = createOfflineAacTrack(audioOptions(4, 3), harness.deps);

    await expect(track.finish()).rejects.toBe(failure);
    expect(harness.samples[0]!.closed).toBe(true);
  });

  it('closes earlier and current samples when a later add rejects', async () => {
    const failure = new Error('second chunk failed');
    let addCount = 0;
    const harness = makeHarness({
      add: async () => {
        addCount += 1;
        if (addCount === 2) throw failure;
      },
    });
    const track = createOfflineAacTrack(audioOptions(2, 5), harness.deps);

    await expect(track.finish()).rejects.toBe(failure);
    expect(harness.samples).toHaveLength(2);
    expect(harness.samples.every((sample) => sample.closed)).toBe(true);
  });

  it('abort before feeding closes the source and makes later operations fail', async () => {
    const harness = makeHarness();
    const track = createOfflineAacTrack(audioOptions(4, 3), harness.deps);
    track.abort();
    track.abort();

    expect(harness.sources[0]!.closeCount).toBe(1);
    await expect(track.feedUntil(1)).rejects.toThrow(/track was aborted/i);
    await expect(track.finish()).rejects.toThrow(/track was aborted/i);
    expect(() => track.attach(harness.output as unknown as Output)).toThrow(/track was aborted/i);
  });

  it('abort during a pending add closes the source and prevents later chunks', async () => {
    let releaseAdd!: () => void;
    const harness = makeHarness({
      add: () => new Promise<void>((resolve) => (releaseAdd = resolve)),
    });
    const track = createOfflineAacTrack(audioOptions(4, 8), harness.deps);
    const feeding = track.feedUntil(2);
    await vi.waitFor(() => expect(harness.sources[0]!.adds).toHaveLength(1));

    track.abort();
    releaseAdd();
    await expect(feeding).rejects.toThrow(/track was aborted/i);
    expect(harness.sources[0]!.adds).toHaveLength(1);
    expect(harness.samples[0]!.closed).toBe(true);
  });

  it('abort stays safe when mediabunny refuses to close a source that was never started', async () => {
    const refusal = new Error(
      'Cannot call close without connecting the source to an output track.',
    );
    const harness = makeHarness({
      close: () => {
        throw refusal;
      },
    });
    const track = createOfflineAacTrack(audioOptions(4, 3), harness.deps);

    expect(() => track.abort()).not.toThrow();
    expect(() => track.abort()).not.toThrow();
    await expect(track.finish()).rejects.toThrow(/track was aborted/i);
  });

  it('finish reports a close failure instead of hiding it', async () => {
    const refusal = new Error('close failed');
    const harness = makeHarness({
      close: () => {
        throw refusal;
      },
    });
    const track = createOfflineAacTrack(audioOptions(4, 3), harness.deps);

    await expect(track.finish()).rejects.toBe(refusal);
  });

  it('abort after feeding closes the source and later finish rejects', async () => {
    const harness = makeHarness();
    const track = createOfflineAacTrack(audioOptions(4, 8), harness.deps);
    await track.feedUntil(1);
    track.abort();

    expect(harness.sources[0]!.closeCount).toBe(1);
    await expect(track.finish()).rejects.toThrow(/track was aborted/i);
  });

  it('rejects invalid duration, sample rate, channel lengths, and channel counts', () => {
    const harness = makeHarness();
    for (const sampleRate of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        createOfflineAacTrack({ channelData: [], sampleRate, durationUs: 0 }, harness.deps),
      ).toThrow(RangeError);
    }
    for (const durationUs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        createOfflineAacTrack({ channelData: [], sampleRate: 1, durationUs }, harness.deps),
      ).toThrow(RangeError);
    }
    expect(() =>
      createOfflineAacTrack(
        { channelData: [new Float32Array(1), new Float32Array(2)], sampleRate: 1, durationUs: 1 },
        harness.deps,
      ),
    ).toThrow(RangeError);
    expect(() =>
      createOfflineAacTrack(
        {
          channelData: [new Float32Array(1), new Float32Array(1), new Float32Array(1)],
          sampleRate: 1,
          durationUs: 1,
        },
        harness.deps,
      ),
    ).toThrow(RangeError);
  });

  it('uses the requested bitrate when provided', () => {
    const sourceFactory = vi.fn(() => ({ add: async () => undefined, close: () => undefined }));
    const deps: OfflineAacTrackDeps = {
      createAudioSample: () => ({ close: () => undefined }),
      createAudioSampleSource: sourceFactory,
    };
    createOfflineAacTrack({ channelData: [], sampleRate: 1, durationUs: 0, bitrate: 64_000 }, deps);

    expect(sourceFactory).toHaveBeenCalledWith({ codec: 'aac', bitrate: 64_000 });
  });
});
