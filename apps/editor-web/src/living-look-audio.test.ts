import { describe, expect, it } from 'vitest';
import { musicPulse } from '@joy-media/motion-core';
import { bakeLookFromAudio, type LookAudioClipPlacement } from './living-look-audio.js';

const SAMPLE_RATE = 48_000;
const CONTROL_VALUES = Object.fromEntries(musicPulse.controls.map((c) => [c.id, c.default]));

const CLIP: LookAudioClipPlacement = {
  compositionStartUs: 0,
  compositionDurationUs: 2_000_000,
  sourceAnchorUs: 0,
  sourcePerComposition: { numerator: 1, denominator: 1 },
};

/** A `durS`-second mono buffer with a decaying low tone on each beat second. */
function pcmWithBeatsAt(seconds: readonly number[], durS = 2): Float32Array {
  const buffer = new Float32Array(Math.round(SAMPLE_RATE * durS));
  const decaySamples = Math.round(0.12 * SAMPLE_RATE);
  for (const second of seconds) {
    const start = Math.round(second * SAMPLE_RATE);
    for (let i = 0; i < decaySamples; i += 1) {
      const index = start + i;
      if (index >= buffer.length) break;
      const envelope = Math.exp((-4 * i) / decaySamples);
      buffer[index] =
        (buffer[index] ?? 0) + Math.sin((2 * Math.PI * 90 * i) / SAMPLE_RATE) * envelope * 0.9;
    }
  }
  return buffer;
}

function bake(pcm: Float32Array, clip: LookAudioClipPlacement = CLIP) {
  return bakeLookFromAudio({
    definition: musicPulse,
    controlValues: CONTROL_VALUES,
    audio: { sampleRate: SAMPLE_RATE, channels: [pcm], sourceOffsetUs: 0 },
    clip,
  });
}

const BEATS = [0.3, 0.6, 0.9, 1.2, 1.5, 1.8];

describe('bakeLookFromAudio (GAP 2)', () => {
  it('bakes the subject-scale bindings with the motion peaking near each beat, within range', () => {
    const result = bake(pcmWithBeatsAt(BEATS));
    expect(result.silent).toBe(false);
    expect(result.confidence).toBeGreaterThan(0.5);

    const bound = new Set(result.audioBakes.map((b) => b.bindingId));
    expect(bound.has('subject-scale-x')).toBe(true);
    expect(bound.has('subject-scale-y')).toBe(true);

    for (const track of result.audioBakes) {
      const values = track.keys.map((k) => k.value);
      const min = Math.min(...values);
      const max = Math.max(...values);
      // Real motion, never outside [rest 1, peak 1.12].
      expect(min).toBeGreaterThanOrEqual(1 - 1e-6);
      expect(max).toBeLessThanOrEqual(1.12 + 1e-6);
      expect(max - min).toBeGreaterThan(0.003);

      // Monotonic composition time inside the window.
      let last = -1;
      for (const key of track.keys) {
        expect(key.timeUs).toBeGreaterThan(last);
        expect(key.timeUs).toBeLessThanOrEqual(CLIP.compositionDurationUs);
        last = key.timeUs;
      }

      // Each beat has a nearby key in the top 40% of the excursion — the motion
      // tracks the audio rather than sitting flat or drifting.
      const threshold = min + 0.4 * (max - min);
      for (const beat of BEATS) {
        const beatUs = beat * 1_000_000;
        const near = track.keys.filter((k) => Math.abs(k.timeUs - beatUs) <= 120_000);
        expect(near.some((k) => k.value >= threshold)).toBe(true);
      }
    }
  });

  it('reports silence honestly and bakes a flat rest line (no invented downbeat)', () => {
    const result = bake(new Float32Array(SAMPLE_RATE * 2));
    expect(result.silent).toBe(true);
    for (const track of result.audioBakes) {
      for (const key of track.keys) expect(key.value).toBeCloseTo(1, 5);
    }
  });

  it('a low-confidence estimate does not invent a beat pattern (flat rest line)', () => {
    // A single quiet transient — not a beat grid.
    const result = bake(pcmWithBeatsAt([1.0]));
    expect(result.confidence).toBeLessThan(0.15);
    for (const track of result.audioBakes) {
      const values = track.keys.map((k) => k.value);
      expect(Math.max(...values) - Math.min(...values)).toBeLessThan(1e-6);
    }
    expect(result.diagnostics.join(' ')).toMatch(/confidence/);
  });

  it('a source speed change re-derives the timing (a stale bake would not match)', () => {
    const normal = bake(pcmWithBeatsAt(BEATS));
    const fast = bake(pcmWithBeatsAt(BEATS), {
      ...CLIP,
      // 2x speed: 2 s of composition consumes 4 s of source, so the 2 s of PCM
      // only fills the first second of the composition window.
      sourcePerComposition: { numerator: 2, denominator: 1 },
    });
    const lastNormal = normal.audioBakes[0]!.keys.at(-1)!.timeUs;
    const lastFast = fast.audioBakes[0]!.keys.at(-1)!.timeUs;
    expect(lastFast).toBeLessThan(lastNormal);
    expect(lastFast).toBeLessThanOrEqual(1_050_000);
  });

  it('returns no bakes for a Look with no numeric keyframe drive', () => {
    const templateOnly = {
      ...musicPulse,
      bindingTargets: musicPulse.bindingTargets.filter((t) => t.channel !== 'keyframe'),
      controls: musicPulse.controls.filter((c) => c.kind === 'color'),
    } as typeof musicPulse;
    const result = bakeLookFromAudio({
      definition: templateOnly,
      controlValues: CONTROL_VALUES,
      audio: { sampleRate: SAMPLE_RATE, channels: [pcmWithBeatsAt(BEATS)], sourceOffsetUs: 0 },
      clip: CLIP,
    });
    expect(result.audioBakes).toEqual([]);
    expect(result.diagnostics[0]).toMatch(/no numeric keyframe drive/);
  });
});
