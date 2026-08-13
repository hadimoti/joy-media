import { describe, expect, it } from 'vitest';
import { motionAnimationToUniversal, universalToMotionAnimation } from './universal-adapter.js';

describe('Motion universal animation adapter', () => {
  it('maps scene-local ownership and preserves hold and cubic timing', () => {
    const universal = motionAnimationToUniversal(
      { id: 'layer-1' },
      {
        property: 'transform.x',
        curve: {
          keyframes: [
            { id: 'a', timeMs: 0, value: 10, easing: { kind: 'builtin', name: 'linear' } },
            {
              id: 'b',
              timeMs: 500,
              value: 20,
              hold: true,
              easing: { kind: 'builtin', name: 'ease-in' },
            },
            {
              id: 'c',
              timeMs: 1000,
              value: 30,
              easing: { kind: 'cubic-bezier', x1: 0.1, y1: 0.2, x2: 0.8, y2: 0.9 },
            },
          ],
        },
      },
    );
    expect(universal.binding).toEqual({
      ownerKind: 'motion-scene-layer',
      ownerId: 'layer-1',
      propertyId: 'transform.x',
      timeDomain: 'scene-local',
    });
    expect(universal.value).toMatchObject({
      kind: 'scalar',
      curve: {
        keyframes: [
          { interpolation: 'linear' },
          { interpolation: 'hold' },
          { interpolation: 'bezier' },
        ],
      },
    });
    expect(universalToMotionAnimation(universal)?.curve.keyframes[1]?.hold).toBe(true);
    expect(universalToMotionAnimation(universal)?.curve.keyframes[2]?.easing).toEqual({
      kind: 'cubic-bezier',
      x1: 0.1,
      y1: 0.2,
      x2: 0.8,
      y2: 0.9,
    });
  });

  it('does not claim non-motion or non-scalar bindings', () => {
    expect(
      universalToMotionAnimation({
        binding: {
          ownerKind: 'visual-object',
          ownerId: 'x',
          propertyId: 'x',
          timeDomain: 'composition',
        },
        value: {
          kind: 'scalar',
          curve: { keyframes: [{ timeUs: 0, value: 1, interpolation: 'linear' }] },
        },
      }),
    ).toBeUndefined();
  });
});
