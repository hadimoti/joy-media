import { describe, expect, it, vi } from 'vitest';
import {
  analyzeAudioObservationWindow,
  assertAudioObservationWindow,
  extractAudioObservationWindow,
  mapSourceTimeToCompositionTime,
} from './observation-analysis.js';
import { sampleStartUs } from './audio.js';

const RATE = 1_000;

describe('audio observation windows', () => {
  it('maps a trimmed, reversed 2x impulse to exact source and composition time', () => {
    const left = new Float32Array(1_000);
    const right = new Float32Array(1_000);
    // The provided PCM begins at source 250 ms, making this sample source 500 ms.
    left[250] = 1;
    right[250] = -0.5;
    const window = extractAudioObservationWindow(
      { sampleRate: RATE, channelData: [left, right], sourceOffsetUs: 250_000 },
      {
        sourceStartUs: 250_000,
        durationUs: 500_000,
        mapping: {
          compositionStartUs: 2_000_000,
          compositionDurationUs: 500_000,
          sourceAnchorUs: 1_000_000,
          direction: 'reverse',
          sourcePerComposition: { numerator: 2, denominator: 1 },
        },
      },
    );

    const analysis = analyzeAudioObservationWindow(window);
    expect(window.sourceStartSample).toBe(0);
    expect(window.sampleCount).toBe(500);
    expect(window.channelData).toHaveLength(2);
    expect(analysis.channels[0]!.peakEvidence).toMatchObject({
      sourceTimeUs: 500_000,
      compositionTimeUs: 2_250_000,
      amplitude: 1,
    });
    expect(analysis.channels[1]!.peakEvidence?.amplitude).toBeCloseTo(-0.5, 6);
  });

  it('preserves each planar channel and records declared deterministic resampling', () => {
    const left = new Float32Array([0, 0.5, 0, 0]);
    const right = new Float32Array([0, 0, -0.75, 0]);
    const window = extractAudioObservationWindow(
      { sampleRate: RATE, channelData: [left, right], sourceOffsetUs: 0 },
      { sourceStartUs: 0, durationUs: 4_000, resampleRate: 2_000 },
    );

    expect(window.channelData).toHaveLength(2);
    expect(window.channelData[0]!.length).toBe(8);
    expect(window.channelData[1]!.length).toBe(8);
    expect(window.resampling).toEqual({
      algorithmVersion: 'linear-v1',
      sourceSampleRate: RATE,
      outputSampleRate: 2_000,
    });
    const analysis = analyzeAudioObservationWindow(window);
    expect(analysis.channels).toHaveLength(2);
    expect(analysis.channels[0]!.peak).toBeCloseTo(0.5, 6);
    expect(analysis.channels[1]!.peak).toBeCloseTo(0.75, 6);
  });

  it('does not silently round invalid timing, layouts, or sample bounds into evidence', () => {
    const mono = new Float32Array(10);
    expect(() =>
      extractAudioObservationWindow(
        { sampleRate: RATE, channelData: [mono], sourceOffsetUs: 0 },
        { sourceStartUs: -1, durationUs: 1_000 },
      ),
    ).toThrow('sourceStartUs');
    expect(() =>
      extractAudioObservationWindow(
        { sampleRate: RATE, channelData: [mono, new Float32Array(9)], sourceOffsetUs: 0 },
        { sourceStartUs: 0, durationUs: 1_000 },
      ),
    ).toThrow('same sample count');
    expect(() =>
      extractAudioObservationWindow(
        { sampleRate: 0, channelData: [mono], sourceOffsetUs: 0 },
        { sourceStartUs: 0, durationUs: 1_000 },
      ),
    ).toThrow('sampleRate');
    expect(() =>
      mapSourceTimeToCompositionTime(500_000, {
        compositionStartUs: 0,
        compositionDurationUs: 1_000_000,
        sourceAnchorUs: 1_000_000,
        direction: 'forward',
        sourcePerComposition: { numerator: 0, denominator: 1 },
      }),
    ).toThrow('sourcePerComposition.numerator');
    expect(() =>
      extractAudioObservationWindow(
        {
          sampleRate: RATE,
          channelData: [new Float32Array(1_000_001)],
          sourceOffsetUs: 0,
        },
        { sourceStartUs: 0, durationUs: 1_000 },
      ),
    ).toThrow('bounded');
  });

  it('rejects aggregate source or resampled visits before it validates or copies PCM', () => {
    const left = new Float32Array(64);
    const right = new Float32Array(64);
    const slice = vi.spyOn(Float32Array.prototype, 'slice');

    try {
      expect(() =>
        extractAudioObservationWindow(
          { sampleRate: RATE, channelData: [left, right], sourceOffsetUs: 0 },
          { sourceStartUs: 0, durationUs: 64_000, maxSampleVisits: 100 },
        ),
      ).toThrow('aggregate sample visit count');
      expect(slice).not.toHaveBeenCalled();

      expect(() =>
        extractAudioObservationWindow(
          { sampleRate: RATE, channelData: [left], sourceOffsetUs: 0 },
          {
            sourceStartUs: 0,
            durationUs: 64_000,
            resampleRate: 2_000,
            maxSampleVisits: 100,
          },
        ),
      ).toThrow('aggregate sample visit count');
      expect(slice).not.toHaveBeenCalled();
    } finally {
      slice.mockRestore();
    }
  });

  it('does not accept an invalid aggregate visit limit', () => {
    expect(() =>
      extractAudioObservationWindow(
        { sampleRate: RATE, channelData: [new Float32Array(16)], sourceOffsetUs: 0 },
        { sourceStartUs: 0, durationUs: 16_000, maxSampleVisits: 0 },
      ),
    ).toThrow('maxSampleVisits');
  });

  it('marks out-of-source windows as truncated instead of padding them as silence', () => {
    const source = { sampleRate: RATE, channelData: [new Float32Array(100)], sourceOffsetUs: 0 };
    const window = extractAudioObservationWindow(source, {
      sourceStartUs: 200_000,
      durationUs: 10_000,
    });
    expect(window.truncated).toBe(true);
    expect(window.sourceSampleCount).toBe(0);
    expect(window.sampleCount).toBe(0);
    expect(window.channelData[0]).toEqual(new Float32Array());
  });

  it('keeps a resampled event tied to its original source sample', () => {
    const samples = new Float32Array(10);
    samples[2] = 1;
    const window = extractAudioObservationWindow(
      { sampleRate: RATE, channelData: [samples], sourceOffsetUs: 0 },
      { sourceStartUs: 0, durationUs: 10_000, resampleRate: 2_000 },
    );
    expect(analyzeAudioObservationWindow(window).channels[0]!.peakEvidence).toMatchObject({
      sourceSampleIndex: 2,
      sourceTimeUs: 2_000,
    });
  });

  it('reports the actual sample-aligned bounds instead of rounding a 44.1 kHz request', () => {
    const source = {
      sampleRate: 44_100,
      channelData: [new Float32Array(44_100)],
      sourceOffsetUs: 0,
    };
    const window = extractAudioObservationWindow(source, {
      sourceStartUs: 500_001,
      durationUs: 1_000,
    });
    expect(window.sourceStartSample).toBe(22_051);
    expect(window.sourceStartUs).toBe(sampleStartUs(22_051, 44_100));
    expect(window.sourceStartUs).toBeGreaterThan(500_001);
  });

  it('keeps reverse clip end boundaries half-open', () => {
    const mapping = {
      compositionStartUs: 0,
      compositionDurationUs: 250_000,
      sourceAnchorUs: 1_000_000,
      direction: 'reverse' as const,
      sourcePerComposition: { numerator: 2, denominator: 1 },
    };
    expect(mapSourceTimeToCompositionTime(500_000, mapping)).toBeUndefined();
    expect(mapSourceTimeToCompositionTime(500_001, mapping)).toBe(249_999);
  });

  it('rejects non-finite local PCM before it can become evidence', () => {
    const samples = new Float32Array(10);
    samples[5] = Number.NaN;
    expect(() =>
      extractAudioObservationWindow(
        { sampleRate: RATE, channelData: [samples], sourceOffsetUs: 0 },
        { sourceStartUs: 0, durationUs: 10_000 },
      ),
    ).toThrow('finite');
  });

  it('rejects forged window declarations before downstream evidence uses them', () => {
    const window = extractAudioObservationWindow(
      { sampleRate: RATE, channelData: [new Float32Array(10)], sourceOffsetUs: 0 },
      { sourceStartUs: 0, durationUs: 10_000, resampleRate: 2_000 },
    );
    const forged = {
      ...window,
      sampleCount: window.sampleCount - 1,
      resampling: { ...window.resampling, algorithmVersion: 'identity-v1' as const },
    };

    expect(() => assertAudioObservationWindow(forged)).toThrow('sample bounds');
    expect(() =>
      analyzeAudioObservationWindow(
        null as unknown as Parameters<typeof analyzeAudioObservationWindow>[0],
      ),
    ).toThrow('window must be an object');
  });
});
