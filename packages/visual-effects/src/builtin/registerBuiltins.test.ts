import { describe, expect, it } from 'vitest';
import { getEffect, listEffects } from '../EffectRegistry.js';
import { registerBuiltins } from './registerBuiltins.js';

describe('registerBuiltins', () => {
  it('is safe to call repeatedly during development reloads', () => {
    registerBuiltins();
    const first = listEffects();

    registerBuiltins();
    const second = listEffects();

    expect(second).toHaveLength(first.length);
    expect(second.map((effect) => effect.id)).toEqual(first.map((effect) => effect.id));
    expect(getEffect('brightness-contrast')).toBeDefined();
  });
});
