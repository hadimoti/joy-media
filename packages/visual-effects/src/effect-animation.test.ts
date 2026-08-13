import { describe, expect, it } from 'vitest';
import {
  assertEffectAnimationDescriptorCoverage,
  buildEffectAnimationDescriptorRegistry,
} from './effect-animation.js';
import { listBuiltinEffects } from './builtin/registerBuiltins.js';
import type { EffectDescriptor } from './types.js';

describe('first-party effect animation descriptor bridge', () => {
  it('classifies every built-in parameter exactly once', () => {
    const descriptors = listBuiltinEffects();
    const entries = buildEffectAnimationDescriptorRegistry(descriptors);

    assertEffectAnimationDescriptorCoverage(descriptors, entries);
    expect(entries).toHaveLength(
      descriptors.reduce((count, effect) => count + effect.params.length, 0),
    );
    expect(
      entries.find((entry) => entry.id === 'object-effect.crt.scanlines')?.classification,
    ).toEqual({
      classification: 'static-with-reason',
      reason:
        'This first-party descriptor marks the parameter static for its current renderer contract.',
    });
    expect(
      entries.find((entry) => entry.id === 'object-effect.brightness-contrast.brightness')
        ?.classification,
    ).toEqual({
      classification: 'creative',
      valueKind: 'scalar',
      interpolation: 'smooth',
    });
  });

  it('rejects ambiguous duplicate effect ids even outside the runtime registry', () => {
    const descriptor: EffectDescriptor = {
      id: 'same',
      label: 'Same',
      category: 'color',
      params: [
        { key: 'amount', label: 'Amount', type: 'number', defaultValue: 0, animatable: true },
      ],
      tags: [],
      backend: { pixiPreview: true, headless: true, ffmpeg: true, deterministic: true },
      cost: 'low',
    };
    expect(() => buildEffectAnimationDescriptorRegistry([descriptor, descriptor])).toThrow(
      'duplicate effect id "same"',
    );
  });
});
