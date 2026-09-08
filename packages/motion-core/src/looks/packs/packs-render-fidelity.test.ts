import { describe, expect, it } from 'vitest';
import { BUILT_IN_LOOK_PACKS } from './index.js';
import { compileLook } from '../compile.js';
import { sampleCurve } from '../../curve.js';
import type { AnimationCurveV1, KeyframeV1 } from '@joy-media/project-schema';
import type { LookCompileInput, LookDefinition } from '../types.js';

/**
 * Render-fidelity checks for the four shipping R2 packs (L3b).
 *
 * The golden test pins the compiled *operation list*. This one closes the next
 * gap: once those `motion.setKeyframe` operations are keyframes on a curve, does
 * the renderer's own evaluator (`sampleCurve`) reproduce the intended shape?
 *
 *  - every keyframe time lands inside the composition;
 *  - sampling exactly at a keyframe time returns that keyframe's value;
 *  - sampling at three fractions [0, 0.5, 1] never escapes the keyframe
 *    value envelope (no interpolation overshoot);
 *  - each pack drives at least one binding with genuine motion (guards the
 *    flat-curve regression at the sampled-value level, not just the op list).
 *
 * Deterministic, no browser — the actual art-directed frame review stays
 * owner-gated (see docs/reviews/joy-live-director-r2-look-scorecard).
 */

const DURATION_US = 8_000_000;
const TOLERANCE = 1e-6;

function compiledKeyframeCurves(
  definition: LookDefinition,
  format: 'portrait' | 'landscape',
): Map<string, { curve: AnimationCurveV1; bindingId: string }> {
  const input: LookCompileInput = {
    definition,
    definitionVersion: definition.version,
    compositionId: 'root',
    compositionDurationUs: DURATION_US,
    format,
    entityBindings: Object.fromEntries(definition.slots.map((slot) => [slot.id, `e-${slot.id}`])),
    controlValues: {},
    overriddenBindingIds: [],
    resolvedFonts: Object.fromEntries(definition.requiredFonts.map((f) => [f, f])),
  };
  const result = compileLook(input);
  expect(result.ok, `${definition.id} (${format}) compiles`).toBe(true);

  const grouped = new Map<string, { keyframes: KeyframeV1[]; bindingId: string }>();
  for (const op of result.operations) {
    if (op.kind !== 'motion.setKeyframe') continue;
    const key = `${op.ownerId}::${op.propertyId}`;
    const entry = grouped.get(key) ?? { keyframes: [], bindingId: op.bindingId };
    entry.keyframes.push({ timeUs: op.timeUs, value: op.value, interpolation: op.interpolation });
    grouped.set(key, entry);
  }

  const curves = new Map<string, { curve: AnimationCurveV1; bindingId: string }>();
  for (const [key, entry] of grouped) {
    const keyframes = [...entry.keyframes].sort((a, b) => a.timeUs - b.timeUs);
    // The compiler must not emit two keyframes at the same time on one channel.
    for (let i = 1; i < keyframes.length; i += 1) {
      expect(
        keyframes[i]!.timeUs,
        `${definition.id} ${key} keyframe ${i} is strictly after ${i - 1}`,
      ).toBeGreaterThan(keyframes[i - 1]!.timeUs);
    }
    curves.set(key, { curve: { keyframes }, bindingId: entry.bindingId });
  }
  return curves;
}

describe('R2 Look pack render fidelity', () => {
  for (const definition of BUILT_IN_LOOK_PACKS) {
    for (const format of ['portrait', 'landscape'] as const) {
      it(`${definition.id} (${format}) samples back to its compiled keyframes`, () => {
        const curves = compiledKeyframeCurves(definition, format);
        expect(
          curves.size,
          `${definition.id} drives at least one keyframe channel`,
        ).toBeGreaterThan(0);

        let sawMotion = false;
        for (const [key, { curve }] of curves) {
          const values = curve.keyframes.map((k) => k.value);
          const min = Math.min(...values);
          const max = Math.max(...values);
          if (max - min > TOLERANCE) sawMotion = true;

          for (const keyframe of curve.keyframes) {
            expect(keyframe.timeUs, `${key} keyframe in composition`).toBeGreaterThanOrEqual(0);
            expect(keyframe.timeUs, `${key} keyframe in composition`).toBeLessThanOrEqual(
              DURATION_US,
            );
            expect(
              sampleCurve(curve, keyframe.timeUs),
              `${definition.id} ${key} @${keyframe.timeUs}`,
            ).toBeCloseTo(keyframe.value, 6);
          }

          for (const fraction of [0, 0.5, 1]) {
            const sampled = sampleCurve(curve, Math.round(fraction * DURATION_US));
            expect(
              sampled,
              `${definition.id} ${key} @${fraction} within envelope`,
            ).toBeGreaterThanOrEqual(min - TOLERANCE);
            expect(
              sampled,
              `${definition.id} ${key} @${fraction} within envelope`,
            ).toBeLessThanOrEqual(max + TOLERANCE);
          }
        }

        expect(sawMotion, `${definition.id} (${format}) animates at least one binding`).toBe(true);
      });
    }
  }
});
