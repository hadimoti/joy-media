import { describe, expect, it, vi } from 'vitest';
import { canonicalBindingKey, type PropertyAnimationV2 } from '@joy-media/project-schema';
import { evaluateFrameProperty } from './frame-property-evaluator.js';

const binding = {
  ownerKind: 'visual-object' as const,
  ownerId: 'title-1',
  propertyId: 'opacity',
  timeDomain: 'composition' as const,
};

const animated: PropertyAnimationV2 = {
  binding,
  value: {
    kind: 'scalar',
    curve: {
      keyframes: [
        { timeUs: 0, value: 0, interpolation: 'linear' },
        { timeUs: 1_000_000, value: 1, interpolation: 'linear' },
      ],
    },
  },
};

function request(overrides: Partial<Parameters<typeof evaluateFrameProperty<number>>[0]> = {}) {
  return {
    binding,
    staticValue: 0.25,
    time: { compositionTimeUs: 500_000 },
    normalize: (value: number | boolean | string | Record<string, unknown>) => Number(value),
    ...overrides,
  };
}

describe('evaluateFrameProperty', () => {
  it('uses only the matching V2 binding and leaves other bindings static', () => {
    const other = {
      ...animated,
      binding: { ...binding, propertyId: 'x' },
    } satisfies PropertyAnimationV2;
    const animations = Object.freeze({
      [canonicalBindingKey(other.binding)]: other,
      [canonicalBindingKey(binding)]: animated,
    });

    const result = evaluateFrameProperty(request({ animations }));

    expect(result.value).toBe(0.5);
    expect(result.source).toBe('v2');
    expect(animations[canonicalBindingKey(binding)]).toBe(animated);
  });

  it('gives a matching V2 animation precedence over the legacy adapter', () => {
    const legacy = { sample: vi.fn(() => 0.9) };

    const result = evaluateFrameProperty(
      request({ animations: { [canonicalBindingKey(binding)]: animated }, legacy }),
    );

    expect(result.value).toBe(0.5);
    expect(result.source).toBe('v2');
    expect(legacy.sample).not.toHaveBeenCalled();
  });

  it('uses the legacy adapter only when that binding has not been migrated', () => {
    const legacy = { sample: vi.fn(() => 0.8) };

    const result = evaluateFrameProperty(request({ legacy }));

    expect(result.value).toBe(0.8);
    expect(result.source).toBe('legacy');
    expect(legacy.sample).toHaveBeenCalledWith(500_000);
  });

  it('evaluates expressions after animation and normalizes their result', () => {
    const result = evaluateFrameProperty(
      request({
        animations: { [canonicalBindingKey(binding)]: animated },
        expression: { evaluate: (base) => Number(base) * 4 },
        normalize: (value) => Math.min(1, Number(value)),
      }),
    );

    expect(result.value).toBe(1);
    expect(result.source).toBe('expression');
  });

  it('falls back to the prior value when an expression fails', () => {
    const result = evaluateFrameProperty(
      request({
        animations: { [canonicalBindingKey(binding)]: animated },
        expression: {
          evaluate: () => {
            throw new Error('unknown symbol');
          },
        },
      }),
    );

    expect(result.value).toBe(0.5);
    expect(result.source).toBe('v2');
    expect(result.diagnostics).toEqual([
      { code: 'PROPERTY_EXPRESSION_FAILED', message: 'unknown symbol' },
    ]);
  });
});
