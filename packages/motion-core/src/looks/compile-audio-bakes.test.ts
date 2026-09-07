import { describe, expect, it } from 'vitest';
import { compileLook } from './compile.js';
import { fixtureDefinition } from './fixture.js';
import type { LookCompileInput } from './types.js';

function baseInput(overrides: Partial<LookCompileInput> = {}): LookCompileInput {
  return {
    definition: fixtureDefinition(),
    definitionVersion: 2,
    compositionId: 'root',
    compositionDurationUs: 10_000_000,
    format: 'portrait',
    entityBindings: { headline: 'title-1', deck: 'title-2', captions: 'cap-1' },
    controlValues: { energy: 0.5, entrance: 'fade', palette: 'ink-on-paper', 'show-deck': true },
    overriddenBindingIds: [],
    resolvedFonts: {},
    ...overrides,
  };
}

const scaleXKeys = [
  { timeUs: 0, value: 1 },
  { timeUs: 2_000_000, value: 1.1 },
  { timeUs: 6_000_000, value: 1 },
  { timeUs: 10_000_000, value: 1 },
];

describe('compileLook — audio bakes', () => {
  it('emits the baked keys verbatim and drops the slider drive for that binding', () => {
    const result = compileLook(
      baseInput({ audioBakes: [{ bindingId: 'headline-scale-x', keys: scaleXKeys }] }),
    );
    expect(result.ok).toBe(true);
    const scaleX = result.operations.filter(
      (o) => o.kind === 'motion.setKeyframe' && o.bindingId === 'headline-scale-x',
    );
    expect(scaleX.map((o) => (o as { timeUs: number }).timeUs)).toEqual([
      0, 2_000_000, 6_000_000, 10_000_000,
    ]);
    expect(scaleX.map((o) => (o as { value: number }).value)).toEqual([1, 1.1, 1, 1]);
    expect(scaleX.every((o) => (o as { interpolation: string }).interpolation === 'linear')).toBe(
      true,
    );
    // The sibling drive (scale-y) is untouched by the bake and still slider-driven.
    expect(result.operations.some((o) => o.bindingId === 'headline-scale-y')).toBe(true);
    expect(result.changedBindingIds).toContain('headline-scale-x');
  });

  it('honours a requested interpolation', () => {
    const result = compileLook(
      baseInput({
        audioBakes: [{ bindingId: 'headline-scale-x', keys: scaleXKeys, interpolation: 'eased' }],
      }),
    );
    const scaleX = result.operations.filter((o) => o.bindingId === 'headline-scale-x');
    expect(scaleX.every((o) => (o as { interpolation: string }).interpolation === 'eased')).toBe(
      true,
    );
  });

  it('is deterministic for identical bakes', () => {
    const bake = { audioBakes: [{ bindingId: 'headline-scale-x', keys: scaleXKeys }] };
    expect(compileLook(baseInput(bake)).operationDigest).toBe(
      compileLook(baseInput(bake)).operationDigest,
    );
  });

  it('fails closed when the bake targets an unknown binding', () => {
    const result = compileLook(
      baseInput({ audioBakes: [{ bindingId: 'no-such-binding', keys: scaleXKeys }] }),
    );
    expect(result.ok).toBe(false);
    expect(result.operations).toEqual([]);
    expect(result.diagnostics.map((d) => d.code)).toContain('LOOK_COMPILE_UNKNOWN_BINDING');
  });

  it('fails closed when the bake targets a template channel', () => {
    const result = compileLook(
      baseInput({ audioBakes: [{ bindingId: 'headline-template', keys: scaleXKeys }] }),
    );
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain('LOOK_COMPILE_BAKE_CHANNEL');
  });

  it('fails closed on a single-key bake', () => {
    const result = compileLook(
      baseInput({
        audioBakes: [{ bindingId: 'headline-scale-x', keys: [{ timeUs: 0, value: 1 }] }],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain('LOOK_COMPILE_BAKE_KEYS');
  });

  it('fails closed on a non-increasing or out-of-range key', () => {
    const outOfRange = compileLook(
      baseInput({
        audioBakes: [
          {
            bindingId: 'headline-scale-x',
            keys: [
              { timeUs: 0, value: 1 },
              { timeUs: 99_000_000, value: 1 },
            ],
          },
        ],
      }),
    );
    expect(outOfRange.ok).toBe(false);
    expect(outOfRange.diagnostics.map((d) => d.code)).toContain('LOOK_COMPILE_BAKE_KEYS');

    const nonIncreasing = compileLook(
      baseInput({
        audioBakes: [
          {
            bindingId: 'headline-scale-x',
            keys: [
              { timeUs: 5_000_000, value: 1 },
              { timeUs: 1_000_000, value: 1 },
            ],
          },
        ],
      }),
    );
    expect(nonIncreasing.ok).toBe(false);
  });

  it('fails closed when the same binding is baked twice', () => {
    const result = compileLook(
      baseInput({
        audioBakes: [
          { bindingId: 'headline-scale-x', keys: scaleXKeys },
          { bindingId: 'headline-scale-x', keys: scaleXKeys },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain('LOOK_COMPILE_BAKE_DUPLICATE');
  });

  it('fails closed when two keys round to the same microsecond', () => {
    const result = compileLook(
      baseInput({
        audioBakes: [
          {
            bindingId: 'headline-scale-x',
            keys: [
              { timeUs: 0, value: 1 },
              { timeUs: 1_000_000.2, value: 1.1 },
              { timeUs: 1_000_000.4, value: 1 },
            ],
          },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain('LOOK_COMPILE_BAKE_KEYS');
  });

  it('skips a bake whose owner slot is an unbound optional slot', () => {
    const result = compileLook(
      baseInput({
        entityBindings: { headline: 'title-1' },
        audioBakes: [{ bindingId: 'deck-opacity', keys: scaleXKeys }],
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.operations.some((o) => o.bindingId === 'deck-opacity')).toBe(false);
  });

  it('leaves a bake unwritten when the operator has overridden that binding', () => {
    const result = compileLook(
      baseInput({
        overriddenBindingIds: ['headline-scale-x'],
        audioBakes: [{ bindingId: 'headline-scale-x', keys: scaleXKeys }],
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.operations.some((o) => o.bindingId === 'headline-scale-x')).toBe(false);
  });
});
