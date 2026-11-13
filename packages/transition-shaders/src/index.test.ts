import { describe, expect, it } from 'vitest';
import {
  buildPixiTransitionFragment,
  getTransitionShader,
  isKnownTransitionType,
  listTransitionShaders,
  listTransitionUniformDescriptors,
  mergeTransitionParams,
  resolveTransitionShaderId,
} from './index.js';

describe('transition-shaders registry', () => {
  it('lists curated entries without the removed doubles dissolve/wipe/slide (T-V08)', () => {
    const ids = listTransitionShaders().map((entry) => entry.id);
    expect(ids).not.toContain('dissolve');
    expect(ids).not.toContain('wipe');
    expect(ids).not.toContain('slide');
    expect(ids).toContain('gl:fade');
    expect(ids).toContain('gl:wipeLeft');
    expect(ids).toContain('gl:Directional');
    expect(ids.some((id) => id.startsWith('gl:'))).toBe(true);
    // Was 18 with the three doubles; 17 remain after T-V08 removed them.
    expect(listTransitionShaders().length).toBeGreaterThanOrEqual(17);
  });

  it('resolves legacy aliases and unknown gl ids', () => {
    expect(resolveTransitionShaderId('dissolve')).toBe('gl:fade');
    expect(getTransitionShader('dissolve')?.glName).toBe('fade');
    expect(isKnownTransitionType('gl:CrossZoom')).toBe(true);
    expect(isKnownTransitionType('gl:nope')).toBe(false);
  });

  it('merges numeric params over defaults', () => {
    const merged = mergeTransitionParams('gl:fadegrayscale', { intensity: 0.8 });
    expect(merged.intensity).toBe(0.8);
  });

  it('derives animatable uniform descriptors from the shader catalog', () => {
    expect(listTransitionUniformDescriptors('gl:fadegrayscale')).toEqual([
      { propertyId: 'intensity', type: 'float', animatable: true, interpolation: 'smooth' },
    ]);
  });

  it('builds a Pixi fragment that samples from/to textures', () => {
    const entry = getTransitionShader('dissolve');
    expect(entry).toBeDefined();
    const frag = buildPixiTransitionFragment(entry!.glsl);
    expect(frag).toContain('getFromColor');
    expect(frag).toContain('getToColor');
    expect(frag).toContain('uTextureTo');
    expect(frag).toContain('transition(vTextureCoord)');
  });
});
