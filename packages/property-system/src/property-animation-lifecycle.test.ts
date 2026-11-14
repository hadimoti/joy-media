import {
  canonicalBindingKey,
  migrateV0ToV1,
  type PropertyAnimationV2,
} from '@joy-media/project-schema';
import { emptySpikeProject } from '@joy-media/test-fixtures';
import { describe, expect, it } from 'vitest';
import {
  clonePropertyAnimations,
  duplicateClipPropertyAnimations,
  removeClipPropertyAnimations,
  removePropertyAnimations,
  shiftCompositionPropertyAnimations,
  splitClipPropertyAnimations,
  benchmarkScalarChannelSampling,
} from './property-animation-lifecycle.js';

const clipBinding = {
  ownerKind: 'color-clip' as const,
  ownerId: 'clip-a',
  propertyId: 'adjust.exposure',
  timeDomain: 'clip-local' as const,
};

const clipAnimation: PropertyAnimationV2 = {
  binding: clipBinding,
  value: {
    kind: 'scalar',
    curve: {
      keyframes: [
        { timeUs: 0, value: 0, interpolation: 'linear' },
        { timeUs: 1_000_000, value: 10, interpolation: 'linear' },
        { timeUs: 2_000_000, value: 20, interpolation: 'linear' },
      ],
    },
  },
};

const effectBinding = {
  ownerKind: 'object-effect' as const,
  ownerId: 'effect-a',
  propertyId: 'blur.amount',
  timeDomain: 'composition' as const,
};

const effectAnimation: PropertyAnimationV2 = {
  binding: effectBinding,
  value: {
    kind: 'scalar',
    curve: { keyframes: [{ timeUs: 0, value: 2, interpolation: 'linear' }] },
  },
};

function project() {
  const base = migrateV0ToV1(emptySpikeProject()).project;
  return {
    ...base,
    propertyAnimations: {
      [canonicalBindingKey(clipBinding)]: clipAnimation,
      [canonicalBindingKey(effectBinding)]: effectAnimation,
    },
  };
}

describe('property animation ownership lifecycle', () => {
  it('copies clip-owned animation for a duplicate without changing its local curve', () => {
    const next = duplicateClipPropertyAnimations(project(), 'clip-a', 'clip-copy');
    const copied =
      next.propertyAnimations?.[canonicalBindingKey({ ...clipBinding, ownerId: 'clip-copy' })];

    expect(copied?.binding.ownerId).toBe('clip-copy');
    expect(copied?.value).toEqual(clipAnimation.value);
    expect(next.propertyAnimations?.[canonicalBindingKey(clipBinding)]).toEqual(clipAnimation);
  });

  it('rebases a split right-hand clip at the cut and preserves its boundary value', () => {
    const next = splitClipPropertyAnimations(project(), 'clip-a', 'clip-right', 1_500_000);
    const split =
      next.propertyAnimations?.[canonicalBindingKey({ ...clipBinding, ownerId: 'clip-right' })];

    expect(split?.value).toEqual({
      kind: 'scalar',
      curve: {
        keyframes: [
          { timeUs: 0, value: 15, interpolation: 'linear' },
          { timeUs: 500_000, value: 20, interpolation: 'linear' },
        ],
      },
    });
  });

  it('removes every deleted clip owner without touching object/effect owners', () => {
    const next = removeClipPropertyAnimations(project(), 'clip-a');

    expect(next.propertyAnimations?.[canonicalBindingKey(clipBinding)]).toBeUndefined();
    expect(next.propertyAnimations?.[canonicalBindingKey(effectBinding)]).toEqual(effectAnimation);
  });

  it('clones and removes object/effect owner animation independently', () => {
    const cloned = clonePropertyAnimations(project(), [
      {
        source: { ownerKind: 'object-effect', ownerId: 'effect-a' },
        target: { ownerKind: 'object-effect', ownerId: 'effect-copy' },
      },
    ]);
    const copyBinding = { ...effectBinding, ownerId: 'effect-copy' };
    expect(cloned.propertyAnimations?.[canonicalBindingKey(copyBinding)]?.binding.ownerId).toBe(
      'effect-copy',
    );

    const removed = removePropertyAnimations(cloned, [
      { ownerKind: 'object-effect', ownerId: 'effect-a' },
    ]);
    expect(removed.propertyAnimations?.[canonicalBindingKey(effectBinding)]).toBeUndefined();
    expect(removed.propertyAnimations?.[canonicalBindingKey(copyBinding)]).toBeDefined();
  });

  it('keeps 500 scalar channels below the WP34 p95 sampling budget', () => {
    const result = benchmarkScalarChannelSampling();
    expect(result.channelCount).toBe(500);
    expect(result.iterations).toBe(25);
    expect(Number.isFinite(result.checksum)).toBe(true);
    expect(result.p95Ms).toBeLessThan(5);
  });

  it('rejects invalid benchmark sizes', () => {
    expect(() => benchmarkScalarChannelSampling(0, 1)).toThrow('channelCount');
    expect(() => benchmarkScalarChannelSampling(1, 0)).toThrow('iterations');
  });

  it('moves composition-domain keys by the shift and leaves clip-local keys alone', () => {
    const compositionBinding = {
      ownerKind: 'visual-object' as const,
      ownerId: 'media-controller-a',
      propertyId: 'visual.transform.opacity',
      timeDomain: 'composition' as const,
    };
    const curve = (times: readonly number[]) => ({
      keyframes: times.map((timeUs, index) => ({
        timeUs,
        value: index + 1,
        interpolation: 'linear' as const,
      })),
    });
    const entries: PropertyAnimationV2[] = [
      {
        binding: compositionBinding,
        value: { kind: 'scalar', curve: curve([2_000_000, 4_000_000]) },
      },
      { binding: clipBinding, value: clipAnimation.value },
    ];

    const forward = shiftCompositionPropertyAnimations(entries, 30_000_000);
    expect(forward[0]!.value).toEqual({
      kind: 'scalar',
      curve: curve([32_000_000, 34_000_000]),
    });
    expect(forward[1]).toEqual(entries[1]);

    // A negative shift rebases at the cut: 1 s becomes 0, the key at 2 s becomes 1 s.
    const backward = shiftCompositionPropertyAnimations(entries, -1_000_000);
    expect(backward[0]!.value).toEqual({
      kind: 'scalar',
      curve: {
        keyframes: [
          { timeUs: 0, value: 1, interpolation: 'linear' },
          { timeUs: 1_000_000, value: 1, interpolation: 'linear' },
          { timeUs: 3_000_000, value: 2, interpolation: 'linear' },
        ],
      },
    });
    expect(backward[1]).toEqual(entries[1]);
    // The input is not changed.
    expect(entries[0]!.value).toEqual({ kind: 'scalar', curve: curve([2_000_000, 4_000_000]) });
  });
});
