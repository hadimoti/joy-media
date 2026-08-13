import {
  canonicalBindingKey,
  colorCurveToSnapshot,
  migrateV0ToV1,
  type PropertyAnimationV2,
} from '@joy-media/project-schema';
import { emptySpikeProject } from '@joy-media/test-fixtures';
import { describe, expect, it } from 'vitest';
import { applyPropertyAnimationCommand } from './property-animation-commands.js';

const binding = {
  ownerKind: 'color-output' as const,
  ownerId: 'output',
  propertyId: 'adjust.exposure',
  timeDomain: 'output' as const,
};
const animation: PropertyAnimationV2 = {
  binding,
  value: {
    kind: 'scalar',
    curve: { keyframes: [{ timeUs: 0, value: 0, interpolation: 'linear' }] },
  },
};
const project = () => migrateV0ToV1(emptySpikeProject()).project;

describe('WP34 property-animation commands', () => {
  it('enable/set/remove/disable operations round-trip through semantic inverses', () => {
    const enabled = applyPropertyAnimationCommand(project(), {
      type: 'propertyAnimation.enable',
      payload: { animation },
    });
    const keyed = applyPropertyAnimationCommand(enabled.project, {
      type: 'propertyAnimation.setKey',
      payload: {
        binding,
        key: { kind: 'scalar', keyframe: { timeUs: 1_000_000, value: 1, interpolation: 'linear' } },
      },
    });
    expect(keyed.project.propertyAnimations?.[canonicalBindingKey(binding)]?.value).toMatchObject({
      curve: { keyframes: [{ value: 0 }, { value: 1 }] },
    });
    expect(applyPropertyAnimationCommand(keyed.project, keyed.inverse).project).toEqual(
      enabled.project,
    );
    expect(applyPropertyAnimationCommand(enabled.project, enabled.inverse).project).toEqual(
      project(),
    );
  });

  it('keeps compound channels atomic and removes empty optional entries', () => {
    const compound: PropertyAnimationV2 = {
      binding: { ...binding, propertyId: 'wheel' },
      value: {
        kind: 'vector',
        curve: {
          x: { keyframes: [{ timeUs: 0, value: 0, interpolation: 'linear' }] },
          y: { keyframes: [{ timeUs: 0, value: 0, interpolation: 'linear' }] },
        },
      },
    };
    const enabled = applyPropertyAnimationCommand(project(), {
      type: 'propertyAnimation.enable',
      payload: { animation: compound },
    });
    expect(() =>
      applyPropertyAnimationCommand(enabled.project, {
        type: 'propertyAnimation.setKey',
        payload: {
          binding: compound.binding,
          key: {
            kind: 'vector',
            timeUs: 1,
            channels: { x: { timeUs: 1, value: 1, interpolation: 'linear' } },
          },
        },
      }),
    ).toThrow(/exactly match/);
    const removed = applyPropertyAnimationCommand(enabled.project, {
      type: 'propertyAnimation.removeKey',
      payload: { binding: compound.binding, timeUs: 0 },
    });
    expect(removed.project.propertyAnimations).toBeUndefined();
  });

  it('accepts only fixed-size snapshots for Color curve properties', () => {
    const colorBinding = { ...binding, propertyId: 'curves.rgb' };
    const snapshot = colorCurveToSnapshot([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ]);
    expect(() =>
      applyPropertyAnimationCommand(project(), {
        type: 'propertyAnimation.replace',
        payload: {
          binding: colorBinding,
          value: {
            kind: 'curve-snapshot',
            samples: [{ timeUs: 0, channels: { rgb: snapshot }, interpolation: 'linear' }],
          },
        },
      }),
    ).not.toThrow();
    expect(() =>
      applyPropertyAnimationCommand(project(), {
        type: 'propertyAnimation.replace',
        payload: {
          binding: colorBinding,
          value: {
            kind: 'curve-snapshot',
            samples: [
              { timeUs: 0, channels: { rgb: snapshot.slice(0, 2) }, interpolation: 'linear' },
            ],
          },
        },
      }),
    ).toThrow('color curve snapshots require one 256-sample');
  });
});
