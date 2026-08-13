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
  it('lists curated entries including legacy dissolve/wipe/slide', () => {
    const ids = listTransitionShaders().map((entry) => entry.id);
    expect(ids).toContain('dissolve');
    expect(ids).toContain('wipe');
    expect(ids).toContain('slide');
    expect(ids.some((id) => id.startsWith('gl:'))).toBe(true);
    expect(listTransitionShaders().length).toBeGreaterThanOrEqual(18);
  });

  it('resolves legacy aliases and unknown gl ids', () => {
    expect(resolveTransitionShaderId('dissolve')).toBe('dissolve');
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
