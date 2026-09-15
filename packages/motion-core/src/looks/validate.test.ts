import { describe, expect, it } from 'vitest';
import { validateLookDefinition } from './validate.js';
import { fixtureDefinition } from './fixture.js';
import type {
  LookColorControl,
  LookDefinition,
  LookEnumControl,
  LookScalarControl,
} from './types.js';

const SCALAR: LookScalarControl = {
  id: 'energy',
  label: 'Energy',
  kind: 'scalar',
  default: 0.5,
  drives: [
    {
      bindingId: 'headline-scale-x',
      min: 1,
      max: 1.4,
      atFractions: [0, 1],
      interpolation: 'eased',
    },
  ],
};

function withControls(...controls: LookDefinition['controls']): LookDefinition {
  return fixtureDefinition({ controls });
}

describe('validateLookDefinition', () => {
  it('accepts the fixture definition', () => {
    expect(validateLookDefinition(fixtureDefinition())).toEqual([]);
  });

  it('rejects a non-kebab-case or duplicate slot id', () => {
    const dup = fixtureDefinition({
      slots: [
        { id: 'headline', label: 'A', ownerKind: 'visual-object', required: true },
        { id: 'headline', label: 'B', ownerKind: 'visual-object', required: false },
      ],
    });
    expect(validateLookDefinition(dup).map((d) => d.code)).toContain('LOOK_DEFINITION_SLOT_ID');
  });

  it('rejects a binding target that names an unknown slot', () => {
    const def = fixtureDefinition();
    const bad = {
      ...def,
      bindingTargets: [
        { ...def.bindingTargets[0]!, ownerSlotId: 'ghost' },
        ...def.bindingTargets.slice(1),
      ],
    };
    expect(validateLookDefinition(bad).map((d) => d.code)).toContain(
      'LOOK_DEFINITION_BINDING_SLOT',
    );
  });

  it('rejects a zero-width or non-finite scalar drive range (but allows descending)', () => {
    const zeroWidth = withControls({
      ...SCALAR,
      drives: [
        {
          bindingId: 'headline-scale-x',
          min: 1,
          max: 1,
          atFractions: [0, 1],
          interpolation: 'linear',
        },
      ],
    });
    expect(validateLookDefinition(zeroWidth).map((d) => d.code)).toContain(
      'LOOK_DEFINITION_CONTROL_RANGE',
    );
    const descending = withControls({
      ...SCALAR,
      drives: [
        {
          bindingId: 'headline-scale-x',
          min: 0,
          max: -48,
          atFractions: [0, 1],
          interpolation: 'eased',
        },
      ],
    });
    expect(validateLookDefinition(descending)).toEqual([]);
  });

  it('rejects atFractions outside [0,1] or not strictly increasing', () => {
    for (const atFractions of [[0, 0], [0, 1.2], [0.5, 0.4], []]) {
      const bad = withControls({
        ...SCALAR,
        drives: [
          { bindingId: 'headline-scale-x', min: 1, max: 2, atFractions, interpolation: 'linear' },
        ],
      });
      expect(validateLookDefinition(bad).map((d) => d.code)).toContain(
        'LOOK_DEFINITION_CONTROL_FRACTIONS',
      );
    }
  });

  it('rejects a scalar control with no drives — a fake slider', () => {
    const bad = withControls({ ...SCALAR, drives: [] });
    expect(validateLookDefinition(bad).map((d) => d.code)).toContain(
      'LOOK_DEFINITION_CONTROL_DRIVES',
    );
  });

  it('rejects an enum drive missing a value for one option', () => {
    const enumControl: LookEnumControl = {
      id: 'entrance',
      label: 'Entrance',
      kind: 'enum',
      options: ['fade', 'rise', 'hold'],
      default: 'fade',
      drives: [
        {
          bindingId: 'headline-opacity',
          byOption: { fade: 0, rise: 0.2 },
          atFractions: [0, 0.15],
          interpolation: 'linear',
        },
      ],
    };
    expect(validateLookDefinition(withControls(SCALAR, enumControl)).map((d) => d.code)).toContain(
      'LOOK_DEFINITION_CONTROL_ENUM_VALUE',
    );
  });

  it('rejects palette colours that are not hex', () => {
    const colorControl: LookColorControl = {
      id: 'palette',
      label: 'Palette',
      kind: 'color',
      default: 'ink-on-paper',
      palettePairs: [{ id: 'ink-on-paper', foreground: 'rebeccapurple', background: '#fff' }],
      drives: [
        {
          bindingId: 'headline-template',
          target: 'text',
          templateByOption: { 'ink-on-paper': 'clean-title' },
        },
      ],
    };
    expect(validateLookDefinition(withControls(SCALAR, colorControl)).map((d) => d.code)).toContain(
      'LOOK_DEFINITION_CONTROL_COLOR_HEX',
    );
  });

  it('rejects a colour/font control with no template drives — a fake slider', () => {
    const colorControl: LookColorControl = {
      id: 'palette',
      label: 'Palette',
      kind: 'color',
      default: 'ink-on-paper',
      palettePairs: [{ id: 'ink-on-paper', foreground: '#111', background: '#fff' }],
      drives: [],
    };
    expect(validateLookDefinition(withControls(SCALAR, colorControl)).map((d) => d.code)).toContain(
      'LOOK_DEFINITION_CONTROL_DRIVES',
    );
  });

  it('rejects a scalar control that drives a template-channel binding', () => {
    const bad = withControls({
      ...SCALAR,
      drives: [
        {
          bindingId: 'headline-template',
          min: 1,
          max: 2,
          atFractions: [0, 1],
          interpolation: 'linear',
        },
      ],
    });
    expect(validateLookDefinition(bad).map((d) => d.code)).toContain(
      'LOOK_DEFINITION_CONTROL_BINDING',
    );
  });

  it('rejects a keyframe binding whose propertyId is not animatable', () => {
    const def = fixtureDefinition();
    const bad = {
      ...def,
      bindingTargets: [
        { ...def.bindingTargets[0]!, propertyId: 'wobble' },
        ...def.bindingTargets.slice(1),
      ],
    };
    expect(validateLookDefinition(bad).map((d) => d.code)).toContain(
      'LOOK_DEFINITION_BINDING_PROPERTY',
    );
  });

  it('rejects a definition carrying a URL or executable fragment anywhere', () => {
    expect(
      validateLookDefinition(fixtureDefinition({ description: 'see https://evil.example' })).map(
        (d) => d.code,
      ),
    ).toContain('LOOK_DEFINITION_FORBIDDEN_TEXT');
    expect(
      validateLookDefinition(fixtureDefinition({ title: '() => fetch(1)' })).map((d) => d.code),
    ).toContain('LOOK_DEFINITION_FORBIDDEN_TEXT');
  });

  it('rejects a missing or non-positive per-format constraint value', () => {
    const def = fixtureDefinition();
    const bad = {
      ...def,
      constraints: { ...def.constraints, portrait: { ...def.constraints.portrait, minHoldUs: 0 } },
    };
    expect(validateLookDefinition(bad).map((d) => d.code)).toContain('LOOK_DEFINITION_CONSTRAINT');
  });

  it('rejects a boolean drive whose whenTrue equals its rest (inert profile)', () => {
    const def = withControls({
      id: 'accent',
      label: 'Accent',
      kind: 'boolean',
      default: false,
      drives: [
        {
          bindingId: 'headline-opacity',
          rest: 1,
          whenTrue: 1,
          whenFalse: 'omit',
          atFractions: [0, 0.5, 1],
          profile: [0, 1, 0],
          interpolation: 'hold',
        },
      ],
    });
    expect(validateLookDefinition(def).map((d) => d.code)).toContain(
      'LOOK_DEFINITION_CONTROL_BOOL_VALUE',
    );
  });

  it('rejects an enum rate drive with a non-integer period count', () => {
    const def = withControls({
      id: 'rate',
      label: 'Rate',
      kind: 'enum',
      options: ['calm', 'driving'],
      default: 'calm',
      drives: [
        {
          bindingId: 'headline-scale-x',
          byOption: { calm: 1, driving: 1 },
          settled: 1.12,
          periodsByOption: { calm: 2.5, driving: 6 },
          interpolation: 'eased',
        },
      ],
    });
    expect(validateLookDefinition(def).map((d) => d.code)).toContain(
      'LOOK_DEFINITION_CONTROL_PERIODS',
    );
  });

  it('accepts an enum rate drive with integer periods and a settled peak', () => {
    const def = withControls({
      id: 'rate',
      label: 'Rate',
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
    });
    expect(validateLookDefinition(def)).toEqual([]);
  });
});
