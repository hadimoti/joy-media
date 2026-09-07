import { describe, expect, it } from 'vitest';
import type { AudioEnvelopePoint, BeatEnvelopeEstimate } from '@joy-media/audio-core';
import { bakeLookAudio, beatEnvelopeToLookEnvelope } from './look-audio-bridge.js';

function point(
  sourceStartUs: number,
  sourceEndUs: number,
  rms: number,
  peak = rms,
): AudioEnvelopePoint {
  return {
    startSample: 0,
    endSample: 0,
    sourceStartUs,
    sourceEndUs,
    channelRms: [rms],
    peak,
    rms,
  };
}

function estimate(overrides: Partial<BeatEnvelopeEstimate> = {}): BeatEnvelopeEstimate {
  return {
    algorithmVersion: 'joy-beat-envelope-v1',
    envelope: [
      point(0, 100_000, 0.1),
      point(100_000, 200_000, 0.5),
      point(200_000, 300_000, 1),
      point(300_000, 400_000, 0.25),
    ],
    onsets: [],
    silent: false,
    hasBeatGrid: true,
    beatTimesUs: [50_000, 250_000],
    beatIntervalUs: 200_000,
    confidence: 0.8,
    ...overrides,
  };
}

describe('beatEnvelopeToLookEnvelope', () => {
  it('maps source midpoints to composition time and normalises level to the peak', () => {
    const envelope = beatEnvelopeToLookEnvelope(estimate(), (us) => us + 1_000_000);
    expect(envelope.evidenceVersion).toBe('joy-beat-envelope-v1');
    expect(envelope.silent).toBe(false);
    expect(envelope.confidence).toBe(0.8);
    expect(envelope.samples.map((s) => s.compositionTimeUs)).toEqual([
      1_050_000, 1_150_000, 1_250_000, 1_350_000,
    ]);
    // rms values 0.1/0.5/1/0.25, peak 1 -> unchanged
    expect(envelope.samples.map((s) => s.level)).toEqual([0.1, 0.5, 1, 0.25]);
    // strictly increasing
    for (let i = 1; i < envelope.samples.length; i += 1) {
      expect(envelope.samples[i]!.compositionTimeUs).toBeGreaterThan(
        envelope.samples[i - 1]!.compositionTimeUs,
      );
    }
  });

  it('drops points the host maps outside the window and dedupes collisions', () => {
    const envelope = beatEnvelopeToLookEnvelope(estimate(), (us) =>
      us < 150_000 ? undefined : Math.min(us, 250_000),
    );
    // first point dropped (undefined); remaining midpoints 150k/250k/350k -> clamp
    // to <=250k so 250k and 250k collide and one is dropped.
    expect(envelope.samples.map((s) => s.compositionTimeUs)).toEqual([150_000, 250_000]);
  });

  it('can normalise against peak instead of rms', () => {
    const est = estimate({
      envelope: [point(0, 100_000, 0.2, 0.4), point(100_000, 200_000, 0.5, 0.8)],
    });
    const envelope = beatEnvelopeToLookEnvelope(est, (us) => us, { channel: 'peak' });
    expect(envelope.samples.map((s) => s.level)).toEqual([0.5, 1]);
  });

  it('passes silence straight through', () => {
    const envelope = beatEnvelopeToLookEnvelope(
      estimate({ silent: true, confidence: 0 }),
      (us) => us,
    );
    expect(envelope.silent).toBe(true);
  });

  it('marks the envelope silent when every point falls outside the mapped window', () => {
    const envelope = beatEnvelopeToLookEnvelope(estimate(), () => undefined);
    expect(envelope.samples).toEqual([]);
    expect(envelope.silent).toBe(true);
  });
});

describe('bakeLookAudio', () => {
  it('produces compiler-ready bakes for the ok results only', () => {
    const envelope = beatEnvelopeToLookEnvelope(estimate(), (us) => us);
    const { bakes, results } = bakeLookAudio(envelope, [
      {
        bindingId: 'subject-scale-x',
        propertyMin: 1,
        propertyMax: 1.12,
        smoothing: 0.2,
        maxKeys: 8,
      },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(true);
    expect(bakes).toHaveLength(1);
    expect(bakes[0]!.bindingId).toBe('subject-scale-x');
    expect(bakes[0]!.keys.length).toBeGreaterThanOrEqual(2);
    for (const key of bakes[0]!.keys) {
      expect(key.value).toBeGreaterThanOrEqual(1);
      expect(key.value).toBeLessThanOrEqual(1.12);
    }
  });

  it('omits a bake whose bake result failed', () => {
    const envelope = beatEnvelopeToLookEnvelope(estimate(), (us) => us);
    const { bakes, results } = bakeLookAudio(envelope, [
      { bindingId: 'bad', propertyMin: 1, propertyMax: 1, smoothing: 0.2, maxKeys: 8 },
    ]);
    expect(results[0]!.ok).toBe(false);
    expect(bakes).toEqual([]);
  });

  it('bakes a flat rest line for a low-confidence estimate', () => {
    const envelope = beatEnvelopeToLookEnvelope(estimate({ confidence: 0.05 }), (us) => us);
    const { bakes, results } = bakeLookAudio(envelope, [
      {
        bindingId: 'subject-scale-x',
        propertyMin: 1,
        propertyMax: 1.12,
        smoothing: 0.2,
        maxKeys: 8,
      },
    ]);
    expect(results[0]!.flat).toBe(true);
    expect(bakes[0]!.keys).toHaveLength(2);
    expect(bakes[0]!.keys.every((k) => k.value === 1)).toBe(true);
  });
});
