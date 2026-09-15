import { describe, expect, it, vi } from 'vitest';
import type { BrowserAudioObservationError } from './audio-observer.js';
import { createBrowserAudioObserver } from './audio-observer.js';

interface FakeAudioBuffer {
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  readonly length: number;
  getChannelData(channel: number): Float32Array;
}

function fakeBuffer(channelData: readonly Float32Array[], sampleRate = 1_000): FakeAudioBuffer {
  return {
    sampleRate,
    numberOfChannels: channelData.length,
    length: channelData[0]?.length ?? 0,
    getChannelData(channel) {
      const value = channelData[channel];
      if (value === undefined) throw new RangeError('missing channel');
      return value;
    },
  };
}

function fakeContext(buffer: FakeAudioBuffer) {
  return {
    decodeAudioData: vi.fn(async () => buffer),
    close: vi.fn(async () => undefined),
  };
}

const DEFAULT_MAPPING = {
  compositionStartUs: 2_000_000,
  compositionDurationUs: 1_000_000,
  sourceAnchorUs: 0,
  direction: 'forward' as const,
  sourcePerComposition: { numerator: 1, denominator: 1 },
};

describe('browser audio observation', () => {
  it('extracts a bounded PCM window and maps an impulse through composition time', async () => {
    const samples = new Float32Array(2_000);
    samples[500] = 1;
    const context = fakeContext(fakeBuffer([samples]));
    const observer = createBrowserAudioObserver({ audioContextFactory: () => context });

    const result = await observer.observe({
      source: new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' }),
      sourceOffsetUs: 0,
      range: { startUs: 0, endUs: 1_000_000 },
      mapping: DEFAULT_MAPPING,
    });

    expect(result.window.sampleCount).toBe(1_000);
    expect(result.window.channelData[0]).not.toBe(samples);
    expect(result.analysis.channels[0]?.peakEvidence).toMatchObject({
      sourceTimeUs: 500_000,
      compositionTimeUs: 2_500_000,
    });
    expect(result.beat.envelope.length).toBeGreaterThan(0);
    expect(context.close).toHaveBeenCalledOnce();
  });

  it('rejects a cancelled request before it reads or decodes media', async () => {
    const context = fakeContext(fakeBuffer([new Float32Array(16)]));
    const controller = new AbortController();
    controller.abort();
    const observer = createBrowserAudioObserver({ audioContextFactory: () => context });

    await expect(
      observer.observe({
        source: new Blob([new Uint8Array([1])]),
        sourceOffsetUs: 0,
        range: { startUs: 0, endUs: 1_000 },
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'cancelled' } satisfies Partial<BrowserAudioObservationError>);
    expect(context.decodeAudioData).not.toHaveBeenCalled();
    expect(context.close).not.toHaveBeenCalled();
  });

  it('fails closed before allocating an oversized input or decoded PCM result', async () => {
    const oversizedInputContext = fakeContext(fakeBuffer([new Float32Array(16)]));
    const oversizedInputObserver = createBrowserAudioObserver({
      maxInputBytes: 2,
      audioContextFactory: () => oversizedInputContext,
    });
    await expect(
      oversizedInputObserver.observe({
        source: new Blob([new Uint8Array([1, 2, 3])]),
        sourceOffsetUs: 0,
        range: { startUs: 0, endUs: 1_000 },
      }),
    ).rejects.toMatchObject({
      code: 'input-too-large',
    } satisfies Partial<BrowserAudioObservationError>);
    expect(oversizedInputContext.decodeAudioData).not.toHaveBeenCalled();

    const decodedContext = fakeContext(fakeBuffer([new Float32Array(1_000)]));
    const decodedObserver = createBrowserAudioObserver({
      maxDecodedBytes: 128,
      audioContextFactory: () => decodedContext,
    });
    await expect(
      decodedObserver.observe({
        source: new Blob([new Uint8Array([1])]),
        sourceOffsetUs: 0,
        range: { startUs: 0, endUs: 1_000_000 },
      }),
    ).rejects.toMatchObject({
      code: 'decoded-audio-too-large',
    } satisfies Partial<BrowserAudioObservationError>);
    expect(decodedContext.close).toHaveBeenCalledOnce();
  });

  it('checks the bytes returned by a Blob-like source before it asks Web Audio to decode', async () => {
    const context = fakeContext(fakeBuffer([new Float32Array(16)]));
    const source = {
      size: 1,
      arrayBuffer: vi.fn(async () => new ArrayBuffer(2)),
    };
    const observer = createBrowserAudioObserver({
      maxInputBytes: 1,
      audioContextFactory: () => context,
    });

    await expect(
      observer.observe({
        source: source as unknown as Blob,
        sourceOffsetUs: 0,
        range: { startUs: 0, endUs: 1_000 },
      }),
    ).rejects.toMatchObject({
      code: 'input-too-large',
    } satisfies Partial<BrowserAudioObservationError>);
    expect(source.arrayBuffer).toHaveBeenCalledOnce();
    expect(context.decodeAudioData).not.toHaveBeenCalled();
  });

  it('rejects aggregate source and resampled output work before it copies planar PCM', async () => {
    const sourceSamples = new Float32Array(64);
    const context = fakeContext(fakeBuffer([sourceSamples, new Float32Array(64)]));
    const observer = createBrowserAudioObserver({
      maxAnalysisSampleVisits: 100,
      audioContextFactory: () => context,
    });
    const slice = vi.spyOn(Float32Array.prototype, 'slice');

    try {
      await expect(
        observer.observe({
          source: new Blob([new Uint8Array([1])]),
          sourceOffsetUs: 0,
          range: { startUs: 0, endUs: 64_000 },
        }),
      ).rejects.toMatchObject({
        code: 'analysis-too-large',
      } satisfies Partial<BrowserAudioObservationError>);
      expect(slice).not.toHaveBeenCalled();
      expect(context.close).toHaveBeenCalledOnce();
    } finally {
      slice.mockRestore();
    }

    const resampleContext = fakeContext(fakeBuffer([new Float32Array(64)]));
    const resampleObserver = createBrowserAudioObserver({
      maxAnalysisSampleVisits: 100,
      audioContextFactory: () => resampleContext,
    });
    const resampleSlice = vi.spyOn(Float32Array.prototype, 'slice');
    try {
      await expect(
        resampleObserver.observe({
          source: new Blob([new Uint8Array([1])]),
          sourceOffsetUs: 0,
          range: { startUs: 0, endUs: 64_000 },
          resampleRate: 2_000,
        }),
      ).rejects.toMatchObject({
        code: 'analysis-too-large',
      } satisfies Partial<BrowserAudioObservationError>);
      expect(resampleSlice).not.toHaveBeenCalled();
      expect(resampleContext.close).toHaveBeenCalledOnce();
    } finally {
      resampleSlice.mockRestore();
    }
  });

  it('retains stereo evidence and does not invent a beat grid for silent audio', async () => {
    const silentContext = fakeContext(
      fakeBuffer([new Float32Array(1_000), new Float32Array(1_000)]),
    );
    const silentObserver = createBrowserAudioObserver({ audioContextFactory: () => silentContext });
    const silent = await silentObserver.observe({
      source: new Blob([new Uint8Array([1])]),
      sourceOffsetUs: 3_000_000,
      range: { startUs: 3_000_000, endUs: 4_000_000 },
    });

    expect(silent.window.channelData).toHaveLength(2);
    expect(silent.analysis.channels).toHaveLength(2);
    expect(silent.beat).toMatchObject({
      silent: true,
      onsets: [],
      hasBeatGrid: false,
      beatTimesUs: [],
      confidence: 0,
    });

    const left = new Float32Array(1_000);
    const right = new Float32Array(1_000);
    right[500] = -1;
    const stereoObserver = createBrowserAudioObserver({
      audioContextFactory: () => fakeContext(fakeBuffer([left, right])),
    });
    const stereo = await stereoObserver.observe({
      source: new Blob([new Uint8Array([1])]),
      sourceOffsetUs: 10_000_000,
      range: { startUs: 10_400_000, endUs: 10_600_000 },
      mapping: {
        compositionStartUs: 2_000_000,
        compositionDurationUs: 200_000,
        sourceAnchorUs: 10_400_000,
        direction: 'forward',
        sourcePerComposition: { numerator: 1, denominator: 1 },
      },
    });

    expect(stereo.window).toMatchObject({
      sourceOffsetUs: 10_000_000,
      sourceStartUs: 10_400_000,
      sourceEndUs: 10_600_000,
      channelCount: 2,
    });
    expect(stereo.analysis.channels[1]?.peakEvidence).toMatchObject({
      sourceTimeUs: 10_500_000,
      compositionTimeUs: 2_100_000,
      amplitude: -1,
    });
    expect(stereo.beat.onsets[0]).toMatchObject({ sourceTimeUs: 10_500_000, strength: 1 });
  });

  it('does not report an unbounded analysis window as a successful observation', async () => {
    const context = fakeContext(fakeBuffer([new Float32Array(2_000)]));
    const observer = createBrowserAudioObserver({
      maxAnalysisSampleVisits: 100,
      audioContextFactory: () => context,
    });

    await expect(
      observer.observe({
        source: new Blob([new Uint8Array([1])]),
        sourceOffsetUs: 0,
        range: { startUs: 0, endUs: 1_000_000 },
      }),
    ).rejects.toMatchObject({
      code: 'analysis-too-large',
    } satisfies Partial<BrowserAudioObservationError>);
    expect(context.close).toHaveBeenCalledOnce();
  });

  it('does not accept a caller budget above the envelope core hard limit', () => {
    expect(() =>
      createBrowserAudioObserver({
        maxAnalysisSampleVisits: 4_000_001,
        audioContextFactory: () => fakeContext(fakeBuffer([new Float32Array(16)])),
      }),
    ).toThrow('maxAnalysisSampleVisits');
  });
});
