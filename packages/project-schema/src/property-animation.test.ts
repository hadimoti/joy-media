import { describe, expect, it } from 'vitest';
import {
  canonicalBindingKey,
  normalizePropertyAnimations,
  type AnimationValueV2,
  type NormalizePropertyAnimationsResult,
  type PropertyAnimationV2,
  type PropertyBindingV2,
  type PropertyOwnerResolverV2,
} from './property-animation.js';
import type { KeyframeV1 } from './v1.js';

function binding(overrides: Partial<PropertyBindingV2> = {}): PropertyBindingV2 {
  return {
    ownerKind: 'visual-object',
    ownerId: 'obj-1',
    propertyId: 'position',
    timeDomain: 'composition',
    ...overrides,
  };
}

function scalarValue(keys: Array<[number, number, KeyframeV1['interpolation']]>): {
  kind: 'scalar';
  curve: { keyframes: KeyframeV1[] };
} {
  return {
    kind: 'scalar',
    curve: {
      keyframes: keys.map(([timeUs, value, interpolation]) => ({ timeUs, value, interpolation })),
    },
  };
}

function animation(overrides: Partial<PropertyAnimationV2> = {}): PropertyAnimationV2 {
  return {
    binding: binding(),
    value: scalarValue([
      [0, 0, 'linear'],
      [1_000_000, 1, 'linear'],
    ]),
    ...overrides,
  };
}

function diagnosticsOf(result: NormalizePropertyAnimationsResult): string[] {
  return result.diagnostics.map((d) => `${d.code}:${d.message}`);
}

describe('canonicalBindingKey', () => {
  it('is stable and identical for equivalent bindings', () => {
    const a = binding();
    const b = binding({ ownerId: 'obj-1', propertyId: 'position', timeDomain: 'composition' });
    expect(canonicalBindingKey(a)).toBe(canonicalBindingKey(b));
  });

  it('distinguishes every addressing field', () => {
    const base = binding();
    expect(canonicalBindingKey(base)).not.toBe(canonicalBindingKey(binding({ ownerId: 'obj-2' })));
    expect(canonicalBindingKey(base)).not.toBe(
      canonicalBindingKey(binding({ propertyId: 'rotation' })),
    );
    expect(canonicalBindingKey(base)).not.toBe(
      canonicalBindingKey(binding({ timeDomain: 'clip-local' })),
    );
    expect(canonicalBindingKey(base)).not.toBe(canonicalBindingKey(binding({ ownerKind: 'clip' })));
  });

  it('escapes the separator inside fields to avoid collisions', () => {
    // "a::b" split across two fields must not collide with different splits.
    const one = canonicalBindingKey({ ...binding(), ownerId: 'a', propertyId: 'b' });
    const two = canonicalBindingKey({ ...binding(), ownerId: 'a::x', propertyId: 'y::b' });
    expect(one).not.toBe(two);
  });
});

describe('normalizePropertyAnimations - valid input', () => {
  it('returns an empty map for absent input', () => {
    for (const absent of [undefined, null]) {
      const result = normalizePropertyAnimations(absent);
      expect(result.animations).toEqual({});
      expect(result.diagnostics).toEqual([]);
    }
  });

  it('accepts a non-object with a single diagnostic', () => {
    const result = normalizePropertyAnimations([animation()]);
    expect(result.animations).toEqual({});
    expect(result.diagnostics).toHaveLength(1);
  });

  it('normalizes a scalar animation and key it canonically', () => {
    const anim = animation();
    const result = normalizePropertyAnimations({ [canonicalBindingKey(anim.binding)]: anim });
    const key = canonicalBindingKey(anim.binding);
    expect(result.diagnostics).toEqual([]);
    expect(Object.keys(result.animations)).toEqual([key]);
    expect(result.animations[key]).toEqual(anim);
  });

  it('accepts boolean, string, vector, color, and snapshot values', () => {
    const boolValue: PropertyAnimationV2 = {
      binding: binding({ propertyId: 'enabled' }),
      value: { kind: 'boolean', keys: [{ timeUs: 0, value: true }] },
    };
    const stringValue: PropertyAnimationV2 = {
      binding: binding({ propertyId: 'label' }),
      value: { kind: 'string', keys: [{ timeUs: 0, value: 'on' }] },
    };
    const vectorValue: PropertyAnimationV2 = {
      binding: binding({ propertyId: 'scale' }),
      value: {
        kind: 'vector',
        curve: {
          x: scalarValue([[0, 0, 'linear']]).curve,
          y: scalarValue([[0, 1, 'linear']]).curve,
        },
      },
    };
    const snapshotValue: PropertyAnimationV2 = {
      binding: binding({ propertyId: 'bake' }),
      value: {
        kind: 'curve-snapshot',
        samples: [
          { timeUs: 0, channels: { master: [0.5] }, interpolation: 'linear' },
          { timeUs: 1_000_000, channels: { master: [1] }, interpolation: 'linear' },
        ],
      },
    };
    const result = normalizePropertyAnimations({
      [canonicalBindingKey(boolValue.binding)]: boolValue,
      [canonicalBindingKey(stringValue.binding)]: stringValue,
      [canonicalBindingKey(vectorValue.binding)]: vectorValue,
      [canonicalBindingKey(snapshotValue.binding)]: snapshotValue,
    });
    expect(result.diagnostics).toEqual([]);
    expect(Object.keys(result.animations)).toHaveLength(4);
  });

  it('is order-independent and returns distinct keys for distinct bindings', () => {
    const a = animation();
    const b = animation({ binding: binding({ propertyId: 'rotation' }) });
    const result = normalizePropertyAnimations({
      [canonicalBindingKey(a.binding)]: a,
      [canonicalBindingKey(b.binding)]: b,
    });
    expect(result.diagnostics).toEqual([]);
    expect(Object.keys(result.animations)).toHaveLength(2);
  });
});

describe('normalizePropertyAnimations - binding diagnostics', () => {
  it('drops an entry with an unknown ownerKind', () => {
    const bad = animation({
      binding: { ...binding(), ownerKind: 'nope' as PropertyBindingV2['ownerKind'] },
    });
    const result = normalizePropertyAnimations({ [canonicalBindingKey(bad.binding)]: bad });
    expect(result.animations).toEqual({});
    expect(diagnosticsOf(result).join()).toContain('PROJECT_SCHEMA_V1_PROPERTY_ANIMATION_BINDING');
  });

  it('drops an entry with an empty ownerId or propertyId', () => {
    for (const overrides of [{ ownerId: '' }, { propertyId: '' }]) {
      const bad = animation({ binding: { ...binding(), ...overrides } });
      const result = normalizePropertyAnimations({ [canonicalBindingKey(bad.binding)]: bad });
      expect(result.animations).toEqual({});
    }
  });

  it('drops an entry whose map key does not equal its canonical binding key', () => {
    const anim = animation();
    const result = normalizePropertyAnimations({ 'arbitrary-id': anim });
    expect(result.animations).toEqual({});
    expect(diagnosticsOf(result).join()).toContain('map key mismatch');
    expect(diagnosticsOf(result).join()).toContain(canonicalBindingKey(anim.binding));
  });

  it('reports a missing owner when an ownerResolver is provided', () => {
    const resolver: PropertyOwnerResolverV2 = (kind, id) => id === 'obj-1';
    const missing = animation({ binding: binding({ ownerId: 'obj-999' }) });
    const result = normalizePropertyAnimations(
      { [canonicalBindingKey(missing.binding)]: missing },
      resolver,
    );
    expect(result.animations).toEqual({});
    expect(diagnosticsOf(result).join()).toContain('does not exist');
  });

  it('skips owner existence checks without a resolver', () => {
    const missing = animation({ binding: binding({ ownerId: 'obj-999' }) });
    const result = normalizePropertyAnimations({ [canonicalBindingKey(missing.binding)]: missing });
    expect(result.diagnostics).toEqual([]);
    expect(Object.keys(result.animations)).toHaveLength(1);
  });
});

describe('normalizePropertyAnimations - value checks', () => {
  it('rejects non-finite keyframe values', () => {
    const bad = animation({ value: scalarValue([[0, Number.NaN, 'linear']]) });
    const result = normalizePropertyAnimations({ [canonicalBindingKey(bad.binding)]: bad });
    expect(result.animations).toEqual({});
    expect(diagnosticsOf(result).join()).toContain('finite');
  });

  it('rejects non-integer or negative keyframe times', () => {
    for (const timeUs of [-1, 1.5]) {
      const bad = animation({ value: scalarValue([[timeUs, 0, 'linear']]) });
      const result = normalizePropertyAnimations({ [canonicalBindingKey(bad.binding)]: bad });
      expect(result.animations).toEqual({});
      expect(diagnosticsOf(result).join()).toContain('timeUs');
    }
  });

  it('rejects keyframes that are not strictly increasing in time', () => {
    const bad = animation({
      value: scalarValue([
        [0, 0, 'linear'],
        [0, 1, 'linear'],
      ]),
    });
    const result = normalizePropertyAnimations({ [canonicalBindingKey(bad.binding)]: bad });
    expect(result.animations).toEqual({});
    expect(diagnosticsOf(result).join()).toContain('strictly increasing');
  });

  it('rejects an empty keyframes array', () => {
    const bad = animation({ value: scalarValue([]) });
    const result = normalizePropertyAnimations({ [canonicalBindingKey(bad.binding)]: bad });
    expect(result.animations).toEqual({});
  });

  it('rejects a vector/color channel record with an empty channel map', () => {
    const bad = animation({
      value: { kind: 'vector', curve: {} } as PropertyAnimationV2['value'],
    });
    const result = normalizePropertyAnimations({ [canonicalBindingKey(bad.binding)]: bad });
    expect(result.animations).toEqual({});
    expect(diagnosticsOf(result).join()).toContain('CHANNEL');
  });

  it('rejects an invalid channel name', () => {
    const bad = animation({
      value: {
        kind: 'color',
        curve: { 'not a channel!': scalarValue([[0, 0, 'linear']]).curve },
      } as PropertyAnimationV2['value'],
    });
    const result = normalizePropertyAnimations({ [canonicalBindingKey(bad.binding)]: bad });
    expect(result.animations).toEqual({});
    expect(diagnosticsOf(result).join()).toContain('invalid channel name');
  });

  it('rejects a boolean discrete key whose value is a number', () => {
    const bad = animation({
      value: { kind: 'boolean', keys: [{ timeUs: 0, value: 1 as unknown as boolean }] },
    });
    const result = normalizePropertyAnimations({ [canonicalBindingKey(bad.binding)]: bad });
    expect(result.animations).toEqual({});
    expect(diagnosticsOf(result).join()).toContain('boolean');
  });

  it('rejects a string discrete key whose value is a number', () => {
    const bad = animation({
      value: { kind: 'string', keys: [{ timeUs: 0, value: 5 as unknown as string }] },
    });
    const result = normalizePropertyAnimations({ [canonicalBindingKey(bad.binding)]: bad });
    expect(result.animations).toEqual({});
    expect(diagnosticsOf(result).join()).toContain('numbers are never discrete holds');
  });

  it('rejects discrete keys out of time order', () => {
    const bad = animation({
      value: {
        kind: 'boolean',
        keys: [
          { timeUs: 1_000_000, value: true },
          { timeUs: 0, value: false },
        ],
      },
    });
    const result = normalizePropertyAnimations({ [canonicalBindingKey(bad.binding)]: bad });
    expect(result.animations).toEqual({});
    expect(diagnosticsOf(result).join()).toContain('strictly increasing');
  });

  it('rejects a snapshot sample with an empty channel table', () => {
    const bad = animation({
      value: {
        kind: 'curve-snapshot',
        samples: [{ timeUs: 0, channels: {}, interpolation: 'linear' }],
      },
    });
    const result = normalizePropertyAnimations({ [canonicalBindingKey(bad.binding)]: bad });
    expect(result.animations).toEqual({});
    expect(diagnosticsOf(result).join()).toContain('SNAPSHOT');
  });

  it('rejects a snapshot channel containing a non-finite value', () => {
    const bad = animation({
      value: {
        kind: 'curve-snapshot',
        samples: [
          { timeUs: 0, channels: { master: [Number.POSITIVE_INFINITY] }, interpolation: 'linear' },
        ],
      },
    });
    const result = normalizePropertyAnimations({ [canonicalBindingKey(bad.binding)]: bad });
    expect(result.animations).toEqual({});
    expect(diagnosticsOf(result).join()).toContain('finite');
  });

  it('rejects snapshot samples that are not strictly increasing in time', () => {
    const bad = animation({
      value: {
        kind: 'curve-snapshot',
        samples: [
          { timeUs: 1_000_000, channels: { master: [1] }, interpolation: 'linear' },
          { timeUs: 0, channels: { master: [0] }, interpolation: 'linear' },
        ],
      },
    });
    const result = normalizePropertyAnimations({ [canonicalBindingKey(bad.binding)]: bad });
    expect(result.animations).toEqual({});
    expect(diagnosticsOf(result).join()).toContain('strictly increasing');
  });

  it('rejects a missing keys array for discrete values', () => {
    const bad = animation({
      value: { kind: 'string', keys: undefined as unknown as readonly [] },
    });
    const result = normalizePropertyAnimations({ [canonicalBindingKey(bad.binding)]: bad });
    expect(result.animations).toEqual({});
  });

  it('rejects an unknown value kind', () => {
    const bad = animation({ value: { kind: 'bogus', curve: {} } as unknown as AnimationValueV2 });
    const result = normalizePropertyAnimations({ [canonicalBindingKey(bad.binding)]: bad });
    expect(result.animations).toEqual({});
    expect(diagnosticsOf(result).join()).toContain('unknown value kind');
  });
});
