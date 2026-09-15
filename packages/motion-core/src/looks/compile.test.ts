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

  it('throws on non-finite, out-of-range, or zero-width inputs', () => {
    const cases: ReadonlyArray<readonly [number, number, number]> = [
      [Number.NaN, 0, 1],
      [-0.1, 0, 1],
      [1.1, 0, 1],
      [0.5, 5, 5],
      [0.5, Number.POSITIVE_INFINITY, 1],
    ];
    for (const [value, min, max] of cases) {
      expect(() => mapLookControl(value, min, max)).toThrow(RangeError);
    }
  });

  it('maps a descending range — 0.25 over [0, -48] is -12', () => {
    expect(mapLookControl(0.25, 0, -48)).toBe(-12);
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
      (o) => o.kind === 'motion.setKeyframe' && o.bindingId === 'headline-scale-x',
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
    const result = compileLook(baseInput({ overriddenBindingIds: ['headline-scale-x'] }));
    expect(result.ok).toBe(true);
    expect(result.operations.some((o) => o.bindingId === 'headline-scale-x')).toBe(false);
    expect(result.changedBindingIds).not.toContain('headline-scale-x');
  });

  it('an explicit reset re-opens exactly the named overridden binding', () => {
    const result = compileLook(
      baseInput({
        overriddenBindingIds: ['headline-scale-x', 'headline-opacity'],
        resetBindingIds: ['headline-scale-x'],
      }),
    );
    expect(result.operations.some((o) => o.bindingId === 'headline-scale-x')).toBe(true);
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

describe('compileLook — boolean drive rest value (GAP 3a)', () => {
  const withAccent = (rest: number | undefined) =>
    fixtureDefinition({
      bindingTargets: [
        {
          bindingId: 'headline-opacity',
          channel: 'keyframe',
          ownerSlotId: 'headline',
          ownerKind: 'visual-object',
          propertyId: 'opacity',
          timeDomain: 'composition',
        },
      ],
      controls: [
        {
          id: 'accent',
          label: 'Accent cuts',
          kind: 'boolean',
          default: false,
          drives: [
            {
              bindingId: 'headline-opacity',
              ...(rest === undefined ? {} : { rest }),
              whenTrue: 1,
              whenFalse: 'omit',
              atFractions: [0, 0.25, 0.5, 0.75, 1],
              profile: [0, 1, 0, 1, 0],
              interpolation: 'hold',
            },
          ],
        },
      ],
      requiredOperationKinds: ['motion.setKeyframe'],
    });

  it('shapes a real rest -> peak -> rest cut when on (profile is not inert)', () => {
    const result = compileLook(
      baseInput({
        definition: withAccent(0),
        entityBindings: { headline: 'title-1' },
        controlValues: { accent: true },
      }),
    );
    expect(result.ok).toBe(true);
    const values = result.operations
      .filter((o) => o.kind === 'motion.setKeyframe' && o.bindingId === 'headline-opacity')
      .map((o) => (o as { value: number }).value);
    expect(values).toEqual([0, 1, 0, 1, 0]);
  });

  it('emits nothing for an omit whenFalse drive when off', () => {
    const result = compileLook(
      baseInput({
        definition: withAccent(0),
        entityBindings: { headline: 'title-1' },
        controlValues: { accent: false },
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.operations.some((o) => o.bindingId === 'headline-opacity')).toBe(false);
  });
});

describe('compileLook — enum rate control (GAP 3b)', () => {
  const withRate = () =>
    fixtureDefinition({
      bindingTargets: [
        {
          bindingId: 'headline-scale-x',
          channel: 'keyframe',
          ownerSlotId: 'headline',
          ownerKind: 'visual-object',
          propertyId: 'scaleX',
          timeDomain: 'composition',
        },
      ],
      controls: [
        {
          id: 'rate',
          label: 'Pulse rate',
          kind: 'enum',
          options: ['calm', 'driving'],
          default: 'calm',
          drives: [
            {
              bindingId: 'headline-scale-x',
              byOption: { calm: 1, driving: 1 },
              settled: 1.12,
              periodsByOption: { calm: 2, driving: 6 },
              interpolation: 'eased',
            },
          ],
        },
      ],
      requiredOperationKinds: ['motion.setKeyframe'],
    });

  it('generates 2*periods + 1 alternating rest/peak keyframes', () => {
    for (const [option, periods] of [
      ['calm', 2],
      ['driving', 6],
    ] as const) {
      const result = compileLook(
        baseInput({
          definition: withRate(),
          entityBindings: { headline: 'title-1' },
          controlValues: { rate: option },
        }),
      );
      expect(result.ok).toBe(true);
      const values = result.operations
        .filter((o) => o.kind === 'motion.setKeyframe' && o.bindingId === 'headline-scale-x')
        .map((o) => (o as { value: number }).value);
      expect(values).toHaveLength(2 * periods + 1);
      expect(values.filter((v) => v === 1.12)).toHaveLength(periods);
      expect(values[0]).toBe(1);
      expect(values[values.length - 1]).toBe(1);
    }
  });
});
