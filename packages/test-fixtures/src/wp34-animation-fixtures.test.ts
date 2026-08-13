import {
  canonicalBindingKey,
  normalizePropertyAnimations,
  validateJoyProjectV1,
} from '@joy-media/project-schema';
import { describe, expect, it } from 'vitest';
import {
  createAnimationOwnershipFixture,
  createLegacyAnimationFixture,
} from './wp34-animation-fixtures.js';

describe('WP34 animation ownership fixtures', () => {
  it('keeps legacy curves and ColorGradeV1 byte-for-byte stable without eager V2 data', () => {
    const fixture = createLegacyAnimationFixture();
    const before = JSON.stringify({
      colorGrade: fixture.colorGrade,
      visualObjects: fixture.visualObjects,
    });

    expect('propertyAnimations' in fixture).toBe(false);
    expect(validateJoyProjectV1(fixture)).toEqual([]);
    expect(normalizePropertyAnimations(fixture.propertyAnimations)).toEqual({
      animations: {},
      diagnostics: [],
    });
    expect(
      JSON.stringify({ colorGrade: fixture.colorGrade, visualObjects: fixture.visualObjects }),
    ).toBe(before);
  });

  it('validates canonical non-colliding bindings across all WP34 ownership boundaries', () => {
    const fixture = createAnimationOwnershipFixture();
    expect(validateJoyProjectV1(fixture)).toEqual([]);

    const normalized = normalizePropertyAnimations(fixture.propertyAnimations);
    expect(normalized.diagnostics).toEqual([]);
    expect(Object.keys(normalized.animations)).toHaveLength(9);
    expect(Object.keys(normalized.animations)).toEqual(
      Object.values(normalized.animations).map((animation) =>
        canonicalBindingKey(animation.binding),
      ),
    );

    const addresses = Object.values(normalized.animations).map((animation) => animation.binding);
    expect(addresses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ownerKind: 'color-output',
          ownerId: 'output-grade',
          timeDomain: 'output',
        }),
        expect.objectContaining({
          ownerKind: 'color-clip',
          ownerId: 'clip-video',
          timeDomain: 'clip-local',
        }),
        expect.objectContaining({ ownerKind: 'audio-clip', timeDomain: 'audio-timeline' }),
        expect.objectContaining({ ownerKind: 'audio-bus', timeDomain: 'audio-timeline' }),
        expect.objectContaining({ ownerKind: 'caption-clip', timeDomain: 'caption-clip-local' }),
        expect.objectContaining({
          ownerKind: 'visual-object',
          ownerId: 'camera-main',
          timeDomain: 'composition',
        }),
        expect.objectContaining({ ownerKind: 'transition', timeDomain: 'transition-local' }),
        expect.objectContaining({
          ownerKind: 'visual-object',
          ownerId: 'scene-main',
          timeDomain: 'composition',
        }),
        expect.objectContaining({ ownerKind: 'motion-scene-layer', timeDomain: 'scene-local' }),
      ]),
    );
  });

  it('keeps Output and selected Clip Color V2 grades independently addressable', () => {
    const fixture = createAnimationOwnershipFixture();
    const animations = Object.values(
      normalizePropertyAnimations(fixture.propertyAnimations).animations,
    );
    const output = animations.find((animation) => animation.binding.ownerKind === 'color-output');
    const clip = animations.find((animation) => animation.binding.ownerKind === 'color-clip');

    expect(fixture.colorGrade).toMatchObject({ version: 2, enabled: true });
    expect(fixture.clipColorGrades?.['clip-video']).toMatchObject({ version: 2, enabled: true });
    expect(output?.binding).toMatchObject({
      ownerId: 'output-grade',
      propertyId: 'adjust.exposure',
      timeDomain: 'output',
    });
    expect(clip?.binding).toMatchObject({
      ownerId: 'clip-video',
      propertyId: 'adjust.saturation',
      timeDomain: 'clip-local',
    });
    expect(canonicalBindingKey(output!.binding)).not.toBe(canonicalBindingKey(clip!.binding));
  });
});
