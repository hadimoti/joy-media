import { describe, expect, it } from 'vitest';
import {
  assertColorPropertyDescriptorCoverage,
  colorPropertyBinding,
  COLOR_PROPERTY_DESCRIPTORS,
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
