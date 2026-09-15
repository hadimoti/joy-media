import { describe, expect, it } from 'vitest';
import {
  LOOK_AUDIO_MIN_CONFIDENCE,
  bakeAudioReactive,
  type BakeAudioReactiveInput,
  type LookAudioEnvelope,
} from './audio-reactive.js';

function envelope(
  levels: readonly number[],
  overrides: Partial<LookAudioEnvelope> = {},
): LookAudioEnvelope {
  return {
    evidenceVersion: 'joy-beat-envelope-v1',
    samples: levels.map((level, i) => ({ compositionTimeUs: i * 100_000, level })),
    silent: false,
    confidence: 0.8,
    ...overrides,
  };
}

function baseInput(overrides: Partial<BakeAudioReactiveInput> = {}): BakeAudioReactiveInput {
  return {
    envelope: envelope([0, 0.2, 1, 0.3, 0]),
    bindingId: 'subject-scale',
    propertyMin: 1,
    propertyMax: 1.2,
    smoothing: 0,
    maxKeys: 32,
    ...overrides,
  };
}

describe('bakeAudioReactive', () => {
  it('a known impulse produces a bounded response at the expected composition time', () => {
    const result = bakeAudioReactive(baseInput());
    expect(result.ok).toBe(true);
    const peak = result.keys.reduce((a, b) => (b.value > a.value ? b : a));
    expect(peak.timeUs).toBe(200_000); // the level-1 sample
    expect(peak.value).toBeCloseTo(1.2);
  });

  it('never overshoots the declared property range under any smoothing', () => {
    for (const smoothing of [0, 0.25, 0.5, 1]) {
      const result = bakeAudioReactive(baseInput({ smoothing }));
      for (const key of result.keys) {
        expect(key.value).toBeGreaterThanOrEqual(1);
        expect(key.value).toBeLessThanOrEqual(1.2);
      }
    }
  });

  it('silence bakes a flat rest curve — two keys, no invented events', () => {
    const result = bakeAudioReactive(
      baseInput({ envelope: envelope([0.9, 0.9, 0.9], { silent: true }) }),
    );
    expect(result.flat).toBe(true);
    expect(result.keys).toHaveLength(2);
    expect(result.keys.every((k) => k.value === 1)).toBe(true);
  });

  it('low beat confidence bakes flat and says so, without inventing downbeats', () => {
    const result = bakeAudioReactive(
      baseInput({
        envelope: envelope([0.2, 1, 0.3], { confidence: LOOK_AUDIO_MIN_CONFIDENCE - 0.01 }),
      }),
    );
    expect(result.flat).toBe(true);
    expect(result.diagnostics.join(' ')).toMatch(/confidence/);
  });

  it('respects maxKeys and reports the approximation error when it decimates', () => {
    const levels = Array.from({ length: 200 }, (_, i) => (Math.sin(i / 3) + 1) / 2);
    const result = bakeAudioReactive(baseInput({ envelope: envelope(levels), maxKeys: 12 }));
    expect(result.decimated).toBe(true);
    expect(result.keys.length).toBeLessThanOrEqual(12);
    expect(result.approximationError).toBeGreaterThan(0);
    expect(result.approximationError).toBeLessThanOrEqual(0.2); // within the property span
  });

  it('is deterministic', () => {
    expect(JSON.stringify(bakeAudioReactive(baseInput()))).toBe(
      JSON.stringify(bakeAudioReactive(baseInput())),
    );
  });

  it('rejects a zero-width range, a bad maxKeys, out-of-range smoothing, unordered samples', () => {
    expect(bakeAudioReactive(baseInput({ propertyMin: 1, propertyMax: 1 })).ok).toBe(false);
    expect(bakeAudioReactive(baseInput({ maxKeys: 1 })).ok).toBe(false);
    expect(bakeAudioReactive(baseInput({ smoothing: 2 })).ok).toBe(false);
    expect(
      bakeAudioReactive(
        baseInput({
          envelope: {
            evidenceVersion: 'v',
            samples: [
              { compositionTimeUs: 100, level: 0.5 },
              { compositionTimeUs: 100, level: 0.5 },
            ],
            silent: false,
            confidence: 0.9,
          },
        }),
      ).ok,
    ).toBe(false);
  });

  it('rejects an envelope with fewer than two samples — one point cannot define motion', () => {
    const oneSample = bakeAudioReactive(
      baseInput({
        envelope: {
          evidenceVersion: 'v',
          samples: [{ compositionTimeUs: 0, level: 0.9 }],
          silent: false,
          confidence: 0.9,
        },
      }),
    );
    expect(oneSample.ok).toBe(false);
    expect(oneSample.keys).toEqual([]);
    expect(bakeAudioReactive(baseInput({ envelope: envelope([]) })).ok).toBe(false);
  });

  it('a descending property range still maps and clamps correctly', () => {
    const result = bakeAudioReactive(baseInput({ propertyMin: 0, propertyMax: -20, restValue: 0 }));
    expect(result.ok).toBe(true);
    for (const key of result.keys) {
      expect(key.value).toBeGreaterThanOrEqual(-20);
      expect(key.value).toBeLessThanOrEqual(0);
    }
  });
});
