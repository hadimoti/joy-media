import { canonicalBindingKey, migrateV0ToV1, type JoyProjectV1 } from '@joy-media/project-schema';
import { emptySpikeProject } from '@joy-media/test-fixtures';
import { describe, expect, it } from 'vitest';
import {
  applyVisualObjectProjectTransaction,
  applyVisualObjectProjectTransactionWithRecord,
} from './index.js';
import {
  legacyPropertyAnimationAdapter,
  migrateLegacyPropertyOnFirstV2Edit,
  restoreLegacyPropertyAnimation,
} from './legacy-property-animation.js';

const curve = {
  keyframes: [
    { timeUs: 0, value: 0, interpolation: 'linear' as const },
    { timeUs: 1_000_000, value: 100, interpolation: 'linear' as const },
  ],
};

const binding = {
  ownerKind: 'visual-object' as const,
  ownerId: 'title',
  propertyId: 'x',
  timeDomain: 'composition' as const,
};

function project(): JoyProjectV1 {
  const base = migrateV0ToV1(emptySpikeProject()).project;
  return {
    ...base,
    visualObjects: {
      title: {
        id: 'title',
        kind: 'text',
        text: 'Title',
        transform: {
          x: 0,
          y: 0,
          scaleX: 1,
          scaleY: 1,
          rotationDeg: 0,
          opacity: 1,
          crop: { left: 0, top: 0, right: 0, bottom: 0 },
        },
        animations: {
          x: curve,
          y: { keyframes: [{ timeUs: 0, value: 20, interpolation: 'linear' }] },
        },
      },
    },
  };
}

describe('lazy legacy property animation bridge', () => {
  it('reads legacy curves without touching serialization', () => {
    const before = project();
    const serialized = JSON.stringify(before);

    const adapter = legacyPropertyAnimationAdapter(before, binding);

    expect(adapter?.sample(500_000)).toBe(50);
    expect(JSON.stringify(before)).toBe(serialized);
    expect(before.propertyAnimations).toBeUndefined();
  });

  it('migrates only the first V2-edited legacy property and restores it exactly', () => {
    const before = project();

    const migrated = migrateLegacyPropertyOnFirstV2Edit(before, binding);

    expect(migrated.project.visualObjects.title?.animations).toEqual({
      y: { keyframes: [{ timeUs: 0, value: 20, interpolation: 'linear' }] },
    });
    expect(migrated.project.propertyAnimations?.[canonicalBindingKey(binding)]?.value).toEqual({
      kind: 'scalar',
      curve,
    });
    expect(migrated.legacy?.curve).toEqual(curve);

    expect(restoreLegacyPropertyAnimation(migrated.project, binding, migrated.legacy)).toEqual(
      before,
    );
  });

  it('moves a legacy curve on the first V2 key edit and makes undo byte-equivalent', () => {
    const before = project();
    const applied = applyVisualObjectProjectTransactionWithRecord(before, {
      label: 'Set title X key',
      commands: [
        {
          type: 'propertyAnimation.setKey',
          payload: {
            binding,
            key: {
              kind: 'scalar',
              keyframe: { timeUs: 500_000, value: 60, interpolation: 'linear' },
            },
          },
        },
      ],
    });

    expect(applied.project.visualObjects.title?.animations?.x).toBeUndefined();
    expect(applied.project.propertyAnimations?.[canonicalBindingKey(binding)]?.value).toMatchObject(
      { curve: { keyframes: [{ value: 0 }, { value: 60 }, { value: 100 }] } },
    );

    const undone = applyVisualObjectProjectTransaction(applied.project, applied.record.inverses);
    expect(JSON.stringify(undone)).toBe(JSON.stringify(before));

    const redone = applyVisualObjectProjectTransaction(undone, applied.record.transaction);
    expect(redone).toEqual(applied.project);
  });
});
