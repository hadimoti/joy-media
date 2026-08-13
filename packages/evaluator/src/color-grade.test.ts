import { describe, expect, it } from 'vitest';
import {
  canonicalBindingKey,
  colorPropertyBinding,
  createIdentityColorGrade,
  type NormalizedPropertyAnimationsV2,
} from '@joy-media/project-schema';
import { evaluateColorGradeAtTime } from './color-grade.js';

const scalar = (value: number) => ({
  kind: 'scalar' as const,
  curve: {
    keyframes: [
      { timeUs: 0, value: 0, interpolation: 'linear' as const },
      { timeUs: 1_000_000, value, interpolation: 'linear' as const },
    ],
  },
});

describe('evaluateColorGradeAtTime', () => {
  it('samples output controls at program time without changing source grade', () => {
    const grade = createIdentityColorGrade();
    const binding = colorPropertyBinding('output', 'adjust.exposure');
    const animations: NormalizedPropertyAnimationsV2 = {
      [canonicalBindingKey(binding)]: { binding, value: scalar(2) },
    };
    const result = evaluateColorGradeAtTime(
      grade,
      animations,
      { scope: 'output' },
      { compositionTimeUs: 500_000, outputTimeUs: 500_000 },
    );
    expect(result.adjust?.exposure).toBe(1);
    expect(grade.adjust?.exposure).toBe(0);
  });

  it('uses the clip-local range rather than output time for clip grades', () => {
    const grade = createIdentityColorGrade();
    const binding = colorPropertyBinding('clip', 'hsl.red.saturation', 'clip-1');
    const animations: NormalizedPropertyAnimationsV2 = {
      [canonicalBindingKey(binding)]: { binding, value: scalar(0.8) },
    };
    const result = evaluateColorGradeAtTime(
      grade,
      animations,
      { scope: 'clip', clipId: 'clip-1' },
      { compositionTimeUs: 1_500_000, clip: { startUs: 1_000_000, durationUs: 1_000_000 } },
    );
    expect(result.hsl?.[0]?.saturation).toBe(0.4);
  });
});
