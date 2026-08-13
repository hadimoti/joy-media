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
  splitClipPropertyAnimations,
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
});
