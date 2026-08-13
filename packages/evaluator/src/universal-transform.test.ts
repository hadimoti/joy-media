import { describe, expect, it } from 'vitest';
import {
  canonicalBindingKey,
  type PropertyAnimationV2,
  type VisualObjectV1,
} from '@joy-media/project-schema';
import {
  evaluateUniversalObjectTransform,
  evaluateUniversalWorldTransform,
  hasUniversalTransformAnimation,
} from './universal-transform.js';

const baseObject = (id: string, overrides: Partial<VisualObjectV1> = {}): VisualObjectV1 => ({
  id,
  kind: 'shape',
  shape: 'rectangle',
  transform: {
    x: 0,
    y: 0,
    scaleX: 1,
    scaleY: 1,
    rotationDeg: 0,
    opacity: 1,
    crop: { left: 0, top: 0, right: 0, bottom: 0 },
  },
  ...overrides,
});

function animation(binding: PropertyAnimationV2['binding'], value: PropertyAnimationV2['value']) {
  return { [canonicalBindingKey(binding)]: { binding, value } };
}

describe('universal transform evaluation', () => {
  it('samples a V2 position vector before parent composition', () => {
    const parent = baseObject('parent', { transform: { ...baseObject('x').transform, x: 10 } });
    const child = baseObject('child', { parentId: parent.id });
    const binding = {
      ownerKind: 'visual-object' as const,
      ownerId: child.id,
      propertyId: 'visual.transform.position',
      timeDomain: 'composition' as const,
    };
    const animations = animation(binding, {
      kind: 'vector',
      curve: {
        x: {
          keyframes: [
            { timeUs: 0, value: 0, interpolation: 'linear' as const },
            { timeUs: 1_000_000, value: 100, interpolation: 'linear' as const },
          ],
        },
        y: {
          keyframes: [
            { timeUs: 0, value: 0, interpolation: 'linear' as const },
            { timeUs: 1_000_000, value: 50, interpolation: 'linear' as const },
          ],
        },
      },
    });
    const objects = { [parent.id]: parent, [child.id]: child };

    expect(
      evaluateUniversalWorldTransform(child.id, objects, 500_000, animations).transform,
    ).toMatchObject({
      x: 60,
      y: 25,
    });
    expect(hasUniversalTransformAnimation(child.id, animations)).toBe(true);
  });

  it('keeps legacy scalar curves and spatial paths active when no V2 binding exists', () => {
    const object = baseObject('path', {
      animations: {
        opacity: {
          keyframes: [
            { timeUs: 0, value: 0, interpolation: 'linear' },
            { timeUs: 1_000_000, value: 1, interpolation: 'linear' },
          ],
        },
      },
      spatialPath: {
        keyframes: [
          { timeUs: 0, point: { x: 0, y: 0 }, interpolation: 'linear' },
          { timeUs: 1_000_000, point: { x: 100, y: 40 }, interpolation: 'linear' },
        ],
      },
    });
    const result = evaluateUniversalObjectTransform(object, { [object.id]: object }, 500_000);

    expect(result.transform).toMatchObject({ x: 50, y: 20, opacity: 0.5 });
    expect(hasUniversalTransformAnimation(object.id, undefined)).toBe(false);
  });

  it('keeps expressions above V2 values for their own channels', () => {
    const object = baseObject('expression', { expressions: { opacity: '0.25' } });
    const binding = {
      ownerKind: 'visual-object' as const,
      ownerId: object.id,
      propertyId: 'visual.transform.opacity',
      timeDomain: 'composition' as const,
    };
    const animations = animation(binding, {
      kind: 'scalar',
      curve: { keyframes: [{ timeUs: 0, value: 0.9, interpolation: 'linear' }] },
    });

    expect(
      evaluateUniversalObjectTransform(object, { [object.id]: object }, 0, animations).transform
        .opacity,
    ).toBe(0.25);
  });
});
