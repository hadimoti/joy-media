import { describe, expect, it } from 'vitest';
import {
  assertColorPropertyDescriptorCoverage,
  colorPropertyBinding,
  COLOR_PROPERTY_DESCRIPTORS,
  colorCurveFromSnapshot,
  colorCurveToSnapshot,
  decodeColorLutReference,
  encodeColorLutReference,
  isColorLutReferenceAvailable,
  createIdentityColorGrade,
  HSL_BAND_IDS,
} from './color.js';

describe('WP34 color property descriptors', () => {
  it('classifies every creative color control with stable HSL identities', () => {
    assertColorPropertyDescriptorCoverage();
    expect(createIdentityColorGrade().hsl?.map((band) => band.id)).toEqual(HSL_BAND_IDS);
    expect(COLOR_PROPERTY_DESCRIPTORS.map((descriptor) => descriptor.id)).toContain('curves.rgb');
    expect(COLOR_PROPERTY_DESCRIPTORS.map((descriptor) => descriptor.id)).toContain(
      'lut.reference',
    );
  });

  it('serializes bounded 256-sample curve snapshots deterministically', () => {
    const snapshot = colorCurveToSnapshot([
      { x: 1, y: 1 },
      { x: 0, y: 0 },
      { x: 0.5, y: 0.75 },
    ]);
    expect(snapshot).toHaveLength(256);
    expect(snapshot[0]).toBe(0);
    expect(snapshot[128]).toBeGreaterThan(0.7);
    expect(colorCurveFromSnapshot(snapshot)).toHaveLength(256);
    expect(() => colorCurveFromSnapshot(snapshot.slice(0, 255))).toThrow(RangeError);
  });

  it('requires an exact project LUT asset hash for custom references', () => {
    const reference = {
      assetId: 'lut-private',
      sha256: 'a'.repeat(64),
      intensity: 0.8,
    };
    const encoded = encodeColorLutReference(reference);
    expect(decodeColorLutReference(encoded)).toEqual({
      assetId: 'lut-private',
      sha256: 'a'.repeat(64),
    });
    expect(
      isColorLutReferenceAvailable(reference, {
        'lut-private': {
          id: 'lut-private',
          kind: 'lut',
          displayName: 'grade.cube',
          sha256: 'a'.repeat(64),
        },
      }),
    ).toBe(true);
    expect(
      isColorLutReferenceAvailable(
        { ...reference, sha256: 'b'.repeat(64) },
        {
          'lut-private': {
            id: 'lut-private',
            kind: 'lut',
            displayName: 'grade.cube',
            sha256: 'a'.repeat(64),
          },
        },
      ),
    ).toBe(false);
  });

  it('uses output and clip-local bindings without addressing UI diagnostics', () => {
    expect(colorPropertyBinding('output', 'adjust.exposure')).toEqual({
      ownerKind: 'color-output',
      ownerId: 'output',
      propertyId: 'adjust.exposure',
      timeDomain: 'output',
    });
    expect(colorPropertyBinding('clip', 'hsl.red.saturation', 'clip-1')).toMatchObject({
      ownerKind: 'color-clip',
      ownerId: 'clip-1',
      timeDomain: 'clip-local',
    });
    expect(() => colorPropertyBinding('clip', 'scopes.waveform', 'clip-1')).toThrow(RangeError);
  });
});
