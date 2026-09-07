import { describe, expect, it } from 'vitest';
import { compileLook, mapLookControl } from './compile.js';
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

describe('mapLookControl', () => {
  it('maps [0, 0.5, 1] over [10, 30] to [10, 20, 30]', () => {
    expect([0, 0.5, 1].map((v) => mapLookControl(v, 10, 30))).toEqual([10, 20, 30]);
  });

  it('throws on non-finite, out-of-range, or inverted inputs', () => {
    const cases: ReadonlyArray<readonly [number, number, number]> = [
      [Number.NaN, 0, 1],
      [-0.1, 0, 1],
      [1.1, 0, 1],
      [0.5, 1, 0],
      [0.5, Number.POSITIVE_INFINITY, 1],
    ];
    for (const [value, min, max] of cases) {
      expect(() => mapLookControl(value, min, max)).toThrow(RangeError);
    }
  });
});

describe('compileLook', () => {
  it('compiles the fixture to keyframe + template operations', () => {
    const result = compileLook(baseInput());
    expect(result.ok).toBe(true);
    const kinds = new Set(result.operations.map((o) => o.kind));
    expect(kinds).toEqual(new Set(['motion.setKeyframe', 'text.setTemplate']));
    // energy 0.5 over [1, 1.4] -> 1.2 at 3 fractions
    const scaleOps = result.operations.filter(
      (o) => o.kind === 'motion.setKeyframe' && o.bindingId === 'headline-scale',
    );
    expect(scaleOps.map((o) => (o as { value: number }).value)).toEqual([1.2, 1.2, 1.2]);
    expect(scaleOps.map((o) => (o as { timeUs: number }).timeUs)).toEqual([
      0, 2_000_000, 10_000_000,
    ]);
  });

  it('is deterministic: identical inputs give the identical operationDigest', () => {
    expect(compileLook(baseInput()).operationDigest).toBe(compileLook(baseInput()).operationDigest);
  });

  it('a different control value changes the digest', () => {
    expect(compileLook(baseInput()).operationDigest).not.toBe(
      compileLook(baseInput({ controlValues: { ...baseInput().controlValues, energy: 0.9 } }))
        .operationDigest,
    );
  });

  it('never writes a binding the operator has overridden', () => {
    const result = compileLook(baseInput({ overriddenBindingIds: ['headline-scale'] }));
    expect(result.ok).toBe(true);
    expect(result.operations.some((o) => o.bindingId === 'headline-scale')).toBe(false);
    expect(result.changedBindingIds).not.toContain('headline-scale');
  });

  it('an explicit reset re-opens exactly the named overridden binding', () => {
    const result = compileLook(
      baseInput({
        overriddenBindingIds: ['headline-scale', 'headline-opacity'],
        resetBindingIds: ['headline-scale'],
      }),
    );
    expect(result.operations.some((o) => o.bindingId === 'headline-scale')).toBe(true);
    expect(result.operations.some((o) => o.bindingId === 'headline-opacity')).toBe(false);
  });

  it('fails with no operations when a required slot is unbound', () => {
    const result = compileLook(baseInput({ entityBindings: { deck: 'title-2' } }));
    expect(result.ok).toBe(false);
    expect(result.operations).toEqual([]);
    expect(result.diagnostics.map((d) => d.code)).toContain('LOOK_COMPILE_UNBOUND_SLOT');
  });

  it('fails when the pinned definitionVersion does not match', () => {
    const result = compileLook(baseInput({ definitionVersion: 1 }));
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain('LOOK_COMPILE_VERSION_MISMATCH');
  });

  it('fails when a control value is out of range — no partial plan', () => {
    const result = compileLook(
      baseInput({ controlValues: { ...baseInput().controlValues, energy: 2 } }),
    );
    expect(result.ok).toBe(false);
    expect(result.operations).toEqual([]);
    expect(result.diagnostics.map((d) => d.code)).toContain('LOOK_COMPILE_CONTROL_RANGE');
  });

  it('fails closed when the definition itself is invalid', () => {
    const result = compileLook(baseInput({ definition: fixtureDefinition({ id: 'Not Kebab' }) }));
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]!.code).toMatch(/^DEFINITION_/);
  });

  it('reports a missing required font as a dependency failure', () => {
    const def = fixtureDefinition({ requiredFonts: ['Vazirmatn Variable'] });
    const result = compileLook(baseInput({ definition: def, resolvedFonts: {} }));
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain('LOOK_COMPILE_MISSING_FONT');
  });

  it('unbound optional slot simply produces no operations for its bindings', () => {
    const result = compileLook(baseInput({ entityBindings: { headline: 'title-1' } }));
    expect(result.ok).toBe(true);
    expect(result.operations.some((o) => o.bindingId === 'deck-opacity')).toBe(false);
  });
});
