import { describe, expect, it } from 'vitest';
import {
  getTransitionShader,
  mergeTransitionParams,
  parseTransitionComponentKey,
  resolveTransitionUniforms,
} from './index.js';

type Rgba = readonly [number, number, number, number];

function uniformValue(type: string, name: string, params?: Record<string, number | number[]>) {
  return resolveTransitionUniforms(type, params).find((uniform) => uniform.name === name)?.value;
}

/** Software copy of Directional.glsl, sampled with the uniforms the filter binds. */
function sampleDirectional(
  uv: readonly [number, number],
  progress: number,
  direction: readonly number[],
  from: (u: number, v: number) => Rgba,
  to: (u: number, v: number) => Rgba,
): Rgba {
  const p = [
    uv[0] + progress * Math.sign(direction[0]!),
    uv[1] + progress * Math.sign(direction[1]!),
  ];
  const f = p.map((item) => item - Math.floor(item)) as [number, number];
  const inside = p.every((item) => item >= 0 && item <= 1);
  return inside ? from(f[0], f[1]) : to(f[0], f[1]);
}

/** Software copy of CircleCrop.glsl. */
function sampleCircleCrop(
  uv: readonly [number, number],
  progress: number,
  ratio: number,
  bgcolor: readonly number[],
  from: Rgba,
  to: Rgba,
): readonly number[] {
  const s = Math.pow(2 * Math.abs(progress - 0.5), 3);
  const dist = Math.hypot(uv[0] - 0.5, (uv[1] - 0.5) / ratio);
  return dist >= s ? bgcolor : progress < 0.5 ? from : to;
}

describe('vector uniforms the transition filter binds (T-V08 review)', () => {
  it('reads component keys that the project can store as plain numbers', () => {
    expect(parseTransitionComponentKey('direction.x')).toEqual({ name: 'direction', index: 0 });
    expect(parseTransitionComponentKey('direction.y')).toEqual({ name: 'direction', index: 1 });
    expect(parseTransitionComponentKey('bgcolor.r')).toEqual({ name: 'bgcolor', index: 0 });
    expect(parseTransitionComponentKey('bgcolor.a')).toEqual({ name: 'bgcolor', index: 3 });
    expect(parseTransitionComponentKey('intensity')).toBeUndefined();
    expect(parseTransitionComponentKey('direction.q')).toBeUndefined();
  });

  it('gives Slide (gl:Directional) a right-to-left direction, the same as the old slide id', () => {
    expect(uniformValue('gl:Directional', 'direction')).toEqual([1, 0]);
    expect(uniformValue('slide', 'direction')).toEqual([1, 0]);
    expect(getTransitionShader('gl:Directional')?.description).toMatch(/from the right/);
  });

  it('takes direction from the project params, whole or per component', () => {
    expect(
      uniformValue('gl:Directional', 'direction', { 'direction.x': 0, 'direction.y': -1 }),
    ).toEqual([0, -1]);
    expect(uniformValue('gl:Directional', 'direction', { direction: [-1, 0] })).toEqual([-1, 0]);
    expect(uniformValue('gl:Directional', 'direction', { 'direction.y': 1 })).toEqual([1, 1]);
  });

  it('gives Circle Crop an opaque black background colour unless the project sets one', () => {
    expect(uniformValue('gl:CircleCrop', 'bgcolor')).toEqual([0, 0, 0, 1]);
    expect(
      uniformValue('gl:CircleCrop', 'bgcolor', {
        'bgcolor.r': 1,
        'bgcolor.g': 0.5,
        'bgcolor.b': 0.25,
      }),
    ).toEqual([1, 0.5, 0.25, 1]);
  });

  it('leaves float params as before', () => {
    expect(uniformValue('gl:fadegrayscale', 'intensity')).toBe(0.3);
    expect(uniformValue('gl:fadegrayscale', 'intensity', { intensity: 0.8 })).toBe(0.8);
    expect(mergeTransitionParams('gl:fadegrayscale', { intensity: 0.8 })).toEqual({
      intensity: 0.8,
    });
    expect(resolveTransitionUniforms('gl:nope')).toEqual([]);
  });

  it('Slide renders different frames at progress 0.25 and 0.75 and moves right to left', () => {
    const direction = uniformValue('slide', 'direction') as readonly number[];
    // A horizontal ramp in red for the outgoing clip, solid blue for the incoming one.
    const from = (u: number): Rgba => [Math.round(u * 255), 0, 0, 255];
    const to = (): Rgba => [0, 0, 255, 255];
    const row = (progress: number) =>
      Array.from({ length: 8 }, (_, i) =>
        sampleDirectional([(i + 0.5) / 8, 0.5], progress, direction, from, to),
      );
    const quarter = row(0.25);
    const threeQuarter = row(0.75);
    expect(quarter).not.toEqual(threeQuarter);
    // At 0.25 the left of the frame shows the outgoing clip moved left by a quarter frame...
    expect(quarter[0]).toEqual(from(0.0625 + 0.25));
    // ...and the incoming clip has come in from the right edge.
    expect(quarter[7]).toEqual(to());
    expect(threeQuarter.filter((pixel) => pixel[2] === 255).length).toBeGreaterThan(
      quarter.filter((pixel) => pixel[2] === 255).length,
    );
    // With direction left at zero (the old bug) nothing moves: every frame is the outgoing clip.
    const still = sampleDirectional([0.9, 0.5], 0.75, [0, 0], from, to);
    expect(still).toEqual(from(0.9));
  });

  it('Circle Crop shows the background colour, not transparency, mid-transition', () => {
    const bgcolor = uniformValue('gl:CircleCrop', 'bgcolor') as readonly number[];
    const corner = sampleCircleCrop([0.02, 0.02], 0.5, 16 / 9, bgcolor, [1, 0, 0, 1], [0, 0, 1, 1]);
    expect(corner).toEqual([0, 0, 0, 1]);
    expect(corner[3]).toBe(1);
  });
});
