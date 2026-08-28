import { describe, expect, it } from 'vitest';
import { EffectRegistryImpl, getEffect, registerEffect } from './EffectRegistry.js';
import type { EffectDescriptor } from './types.js';

const descriptor: EffectDescriptor = {
  id: 'test-effect',
  label: 'Test Effect',
  category: 'color',
  description: 'A test effect',
  params: [],
  tags: ['test'],
  backend: {
    pixiPreview: true,
    headless: true,
    ffmpeg: false,
    deterministic: true,
  },
  cost: 'low',
};

describe('EffectRegistryImpl', () => {
  it('registers an effect without a factory', () => {
    const registry = new EffectRegistryImpl();
    registry.registerEffect(descriptor);
    expect(registry.hasEffect('test-effect')).toBe(true);
    expect(registry.getEffect('test-effect')).toEqual(descriptor);
  });

  it('registers an effect with a factory', () => {
    const registry = new EffectRegistryImpl();
    const factory = () => ({ kind: 'test' });
    registry.registerEffect(descriptor, factory);
    expect(registry.hasEffect('test-effect')).toBe(true);
    expect(registry.listEffects()).toContainEqual(descriptor);
  });

  it('rejects duplicate effect ids', () => {
    const registry = new EffectRegistryImpl();
    registry.registerEffect(descriptor);
    expect(() => registry.registerEffect(descriptor)).toThrow('already registered');
  });
});

describe('registerEffect helper', () => {
  it('registers without a factory using the shared registry', () => {
    const id = 'helper-no-factory';
    registerEffect({ ...descriptor, id });
    expect(getEffect(id)).toEqual({ ...descriptor, id });
  });
});
