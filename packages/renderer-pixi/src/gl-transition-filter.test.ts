import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGlTransitionUniforms, createGlTransitionFilter } from './gl-transition-filter.js';

interface UniformGroupLike {
  uniforms: Record<string, number | Float32Array | Int32Array>;
  uniformStructures: Record<string, { type: string }>;
}

function group(handle: ReturnType<typeof createGlTransitionFilter>): UniformGroupLike {
  return handle!.filter.resources['transitionUniforms'] as UniformGroupLike;
}

describe('gl transition filter uniforms (T-V08 review)', () => {
  beforeEach(() => {
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => null }) });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('binds Directional direction as a vec2, right to left by default', () => {
    const handle = createGlTransitionFilter('gl:Directional');
    const uniforms = group(handle);
    expect(uniforms.uniformStructures['direction']?.type).toBe('vec2<f32>');
    expect([...(uniforms.uniforms['direction'] as Float32Array)]).toEqual([1, 0]);
    handle!.destroy();
  });

  it('gives the old slide id the same moving direction', () => {
    const handle = createGlTransitionFilter('slide');
    expect([...(group(handle).uniforms['direction'] as Float32Array)]).toEqual([1, 0]);
    handle!.destroy();
  });

  it('takes direction from project params and updates it per frame', () => {
    const handle = createGlTransitionFilter('gl:Directional', {
      'direction.x': 0,
      'direction.y': -1,
    });
    const uniforms = group(handle);
    expect([...(uniforms.uniforms['direction'] as Float32Array)]).toEqual([0, -1]);
    handle!.setParams({ 'direction.x': -1, 'direction.y': 0 });
    expect([...(uniforms.uniforms['direction'] as Float32Array)]).toEqual([-1, 0]);
    handle!.setParams({ direction: [0, 1] });
    expect([...(uniforms.uniforms['direction'] as Float32Array)]).toEqual([0, 1]);
    handle!.destroy();
  });

  it('binds Circle Crop bgcolor as a vec4, opaque black by default', () => {
    const handle = createGlTransitionFilter('gl:CircleCrop');
    const uniforms = group(handle);
    expect(uniforms.uniformStructures['bgcolor']?.type).toBe('vec4<f32>');
    expect([...(uniforms.uniforms['bgcolor'] as Float32Array)]).toEqual([0, 0, 0, 1]);
    handle!.setParams({ 'bgcolor.r': 1, 'bgcolor.g': 0.5 });
    expect([...(uniforms.uniforms['bgcolor'] as Float32Array)]).toEqual([1, 0.5, 0, 1]);
    handle!.destroy();
  });

  it('keeps float uniforms as before', () => {
    const handle = createGlTransitionFilter('gl:fadegrayscale', { intensity: 0.8 });
    const uniforms = group(handle);
    expect(uniforms.uniformStructures['intensity']?.type).toBe('f32');
    expect(uniforms.uniforms['intensity']).toBeCloseTo(0.8);
    handle!.setParams({ intensity: 0.2 });
    expect(uniforms.uniforms['intensity']).toBeCloseTo(0.2);
    handle!.setProgress(0.4);
    expect(uniforms.uniforms['uProgress']).toBeCloseTo(0.4);
    handle!.destroy();
  });

  it('never declares a component key as a float uniform', () => {
    const plan = buildGlTransitionUniforms('gl:Directional', { 'direction.x': 1 });
    expect(Object.keys(plan!.uniforms).sort()).toEqual(['direction', 'uProgress', 'uRatio']);
    expect(plan!.fragment).not.toMatch(/uniform float direction/);
    expect(plan!.fragment.match(/uniform vec2 direction;/g)).toHaveLength(1);
    expect(buildGlTransitionUniforms('gl:nope')).toBeUndefined();
  });
});
