import { describe, expect, it } from 'vitest';
import {
  compileLook,
  musicPulse,
  sampleCurve,
  type AnimationCurveV1,
  type LookCompileInput,
} from '@joy-media/motion-core';
import { bakeLookFromAudio, type LookAudioClipPlacement } from './living-look-audio.js';

/**
 * GAP 2 render-side acceptance at the evaluator level.
 *
 * Numeric bake tests alone do not close GAP 2/4: what matters is that the
 * renderer's own curve evaluator (`sampleCurve` — the same code the Monitor and
 * the export share) reproduces the audio-reactive motion the bake intended.
 *
 * This test drives the whole editor path — synthetic beat audio →
 * `bakeLookFromAudio` → `compileLook` (baked keys supersede the slider drive) →
 * curve → `sampleCurve` — and asserts the subject scale peaks near each beat and
 * rests between, staying inside the pack's declared `[1, 1.12]` range. The full
 * decoded-*exported-media* check remains the e2e acceptance gate
 * (`tests/e2e/living-looks-audio-motion.spec.ts`).
 */

const SAMPLE_RATE = 48_000;
const DURATION_US = 2_000_000;
const BEATS_S = [0.3, 0.6, 0.9, 1.2, 1.5, 1.8];

const CLIP: LookAudioClipPlacement = {
  compositionStartUs: 0,
  compositionDurationUs: DURATION_US,
  sourceAnchorUs: 0,
  sourcePerComposition: { numerator: 1, denominator: 1 },
};

function beatAudio(): Float32Array {
  const buffer = new Float32Array(Math.round(SAMPLE_RATE * (DURATION_US / 1_000_000)));
  const decaySamples = Math.round(0.12 * SAMPLE_RATE);
  for (const second of BEATS_S) {
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

function curvesFromCompiledLook(input: LookCompileInput): Map<string, AnimationCurveV1> {
  const result = compileLook(input);
  expect(result.ok).toBe(true);
  const grouped = new Map<
    string,
    { timeUs: number; value: number; interpolation: 'hold' | 'linear' | 'eased' }[]
  >();
  for (const op of result.operations) {
    if (op.kind !== 'motion.setKeyframe') continue;
    const key = `${op.ownerId}::${op.propertyId}`;
    const list = grouped.get(key) ?? [];
    list.push({ timeUs: op.timeUs, value: op.value, interpolation: op.interpolation });
    grouped.set(key, list);
  }
  const curves = new Map<string, AnimationCurveV1>();
  for (const [key, list] of grouped) {
    curves.set(key, { keyframes: [...list].sort((a, b) => a.timeUs - b.timeUs) });
  }
  return curves;
}

describe('audio-reactive Look motion is reproduced by the renderer evaluator (GAP 2)', () => {
  it('the subject scale peaks near each beat and rests between, within range', () => {
    const controlValues = Object.fromEntries(musicPulse.controls.map((c) => [c.id, c.default]));
    const baked = bakeLookFromAudio({
      definition: musicPulse,
      controlValues,
      audio: { sampleRate: SAMPLE_RATE, channels: [beatAudio()], sourceOffsetUs: 0 },
      clip: CLIP,
    });
    expect(baked.silent).toBe(false);
    expect(baked.audioBakes.some((b) => b.bindingId === 'subject-scale-x')).toBe(true);

    const curves = curvesFromCompiledLook({
      definition: musicPulse,
      definitionVersion: musicPulse.version,
      compositionId: 'root',
      compositionDurationUs: DURATION_US,
      format: 'portrait',
      entityBindings: { subject: 'headline', accent: 'badge', captions: 'caption-clip-1' },
      controlValues,
      overriddenBindingIds: [],
      resolvedFonts: Object.fromEntries(musicPulse.requiredFonts.map((f) => [f, f])),
      audioBakes: baked.audioBakes,
    });

    const scaleCurve = curves.get('headline::scaleX');
    expect(scaleCurve).toBeDefined();
    if (scaleCurve === undefined) return;

    // Full range stays inside the pack's declared rest/peak.
    for (const key of scaleCurve.keyframes) {
      expect(key.value).toBeGreaterThanOrEqual(1 - 1e-6);
      expect(key.value).toBeLessThanOrEqual(1.12 + 1e-6);
    }

    // The renderer's evaluator: near each beat there is a sampled scale clearly
    // above the resting value; midway between beats it settles back.
    const restingSamples = BEATS_S.slice(0, -1).map((beat, i) => {
      const midUs = ((beat + BEATS_S[i + 1]!) / 2) * 1_000_000;
      return sampleCurve(scaleCurve, Math.round(midUs));
    });
    const restingMax = Math.max(...restingSamples);

    let beatsThatPop = 0;
    for (const beat of BEATS_S) {
      const beatUs = beat * 1_000_000;
      const nearby = [beatUs - 30_000, beatUs, beatUs + 30_000, beatUs + 60_000]
        .filter((t) => t >= 0 && t <= DURATION_US)
        .map((t) => sampleCurve(scaleCurve, Math.round(t)));
      if (Math.max(...nearby) > restingMax + 0.001) beatsThatPop += 1;
    }
    // The motion tracks the audio at the majority of beats.
    expect(beatsThatPop).toBeGreaterThanOrEqual(Math.ceil(BEATS_S.length / 2));
  });

  it('silence renders a flat scale (no motion the evaluator can sample)', () => {
    const controlValues = Object.fromEntries(musicPulse.controls.map((c) => [c.id, c.default]));
    const baked = bakeLookFromAudio({
      definition: musicPulse,
      controlValues,
      audio: {
        sampleRate: SAMPLE_RATE,
        channels: [new Float32Array(SAMPLE_RATE * 2)],
        sourceOffsetUs: 0,
      },
      clip: CLIP,
    });
    const curves = curvesFromCompiledLook({
      definition: musicPulse,
      definitionVersion: musicPulse.version,
      compositionId: 'root',
      compositionDurationUs: DURATION_US,
      format: 'portrait',
      entityBindings: { subject: 'headline', accent: 'badge', captions: 'caption-clip-1' },
      controlValues,
      overriddenBindingIds: [],
      resolvedFonts: Object.fromEntries(musicPulse.requiredFonts.map((f) => [f, f])),
      audioBakes: baked.audioBakes,
    });
    const scaleCurve = curves.get('headline::scaleX');
    if (scaleCurve === undefined) return;
    const samples = [0, 0.25, 0.5, 0.75, 1].map((f) =>
      sampleCurve(scaleCurve, Math.round(f * DURATION_US)),
    );
    expect(Math.max(...samples) - Math.min(...samples)).toBeLessThan(1e-6);
  });
});
