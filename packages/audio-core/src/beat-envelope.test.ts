import { describe, expect, it } from 'vitest';
import { extractAudioObservationWindow } from './observation-analysis.js';
import { buildBeatEnvelope } from './beat-envelope.js';

const RATE = 1_000;

function observe(samples: Float32Array) {
  return extractAudioObservationWindow(
    { sampleRate: RATE, channelData: [samples], sourceOffsetUs: 0 },
    { sourceStartUs: 0, durationUs: samples.length * 1_000 },
  );
}

describe('local beat envelope', () => {
  it('keeps silence honest: no onset or invented beat grid', () => {
    const envelope = buildBeatEnvelope(observe(new Float32Array(RATE)), {
      frameSizeSamples: 50,
      hopSamples: 25,
    });

    expect(envelope.algorithmVersion).toBe('joy-beat-envelope-v1');
    expect(envelope.silent).toBe(true);
    expect(envelope.onsets).toEqual([]);
    expect(envelope.hasBeatGrid).toBe(false);
    expect(envelope.beatTimesUs).toEqual([]);
    expect(envelope.confidence).toBe(0);
  });

  it('finds a local impulse onset at its sample-derived source time', () => {
    const samples = new Float32Array(RATE);
    samples[500] = 1;
    const envelope = buildBeatEnvelope(observe(samples), {
      frameSizeSamples: 25,
      hopSamples: 25,
    });

    expect(envelope.onsets[0]).toMatchObject({ sourceTimeUs: 500_000, strength: 1 });
    expect(envelope.hasBeatGrid).toBe(false);
  });

  it('retains a right-channel-only impulse instead of cancelling or dropping stereo evidence', () => {
    const left = new Float32Array(RATE);
    const right = new Float32Array(RATE);
    right[500] = -1;
    const window = extractAudioObservationWindow(
      { sampleRate: RATE, channelData: [left, right], sourceOffsetUs: 0 },
      { sourceStartUs: 0, durationUs: 1_000_000 },
    );
    const envelope = buildBeatEnvelope(window, { frameSizeSamples: 25, hopSamples: 25 });

    expect(envelope.onsets[0]).toMatchObject({ sourceTimeUs: 500_000, strength: 1 });
    expect(envelope.envelope[20]!.channelRms).toEqual([0, 0.2]);
  });

  it('estimates a confidence-scored beat grid only from regular observed onsets', () => {
    const samples = new Float32Array(3_000);
    for (const sampleIndex of [250, 750, 1_250, 1_750, 2_250]) samples[sampleIndex] = 1;
    const envelope = buildBeatEnvelope(observe(samples), {
      frameSizeSamples: 25,
      hopSamples: 25,
    });

    expect(envelope.hasBeatGrid).toBe(true);
    expect(envelope.beatIntervalUs).toBe(500_000);
    expect(envelope.beatTimesUs).toEqual([250_000, 750_000, 1_250_000, 1_750_000, 2_250_000]);
    expect(envelope.confidence).toBeGreaterThan(0.9);
  });

  it('does not promote irregular observed onsets into a beat grid', () => {
    const samples = new Float32Array(2_200);
    for (const sampleIndex of [250, 600, 1_450, 1_800]) samples[sampleIndex] = 1;
    const envelope = buildBeatEnvelope(observe(samples), {
      frameSizeSamples: 25,
      hopSamples: 25,
    });

    expect(envelope.onsets).toHaveLength(4);
    expect(envelope.hasBeatGrid).toBe(false);
    expect(envelope.beatTimesUs).toEqual([]);
    expect(envelope.confidence).toBe(0);
  });

  it('rejects invalid envelope settings instead of fabricating a result', () => {
    expect(() =>
      buildBeatEnvelope(observe(new Float32Array(RATE)), { frameSizeSamples: 0 }),
    ).toThrow('frameSizeSamples');
    expect(() =>
      buildBeatEnvelope(observe(new Float32Array(RATE)), {
        frameSizeSamples: 1,
        hopSamples: 1,
      }),
    ).toThrow('bounded');
    expect(() =>
      buildBeatEnvelope(
        observe(new Float32Array(RATE)),
        null as unknown as Parameters<typeof buildBeatEnvelope>[1],
      ),
    ).toThrow('options must be an object');
    expect(() =>
      buildBeatEnvelope(observe(new Float32Array(1_000_000)), {
        frameSizeSamples: 1_000_000,
        hopSamples: 1_954,
      }),
    ).toThrow('bounded PCM analysis work');
  });
});
