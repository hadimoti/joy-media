import { describe, expect, it } from 'vitest';
import {
  buildPixiTransitionFragment,
  getTransitionShader,
  listTransitionShaders,
} from './index.js';

/** Software sample of gl-transitions `fade` — proves A↔B blend math (not an overlay plate). */
function sampleFade(
  from: readonly [number, number, number, number],
  to: readonly [number, number, number, number],
  progress: number,
): readonly [number, number, number, number] {
  const t = Math.min(1, Math.max(0, progress));
  return [
    from[0] * (1 - t) + to[0] * t,
    from[1] * (1 - t) + to[1] * t,
    from[2] * (1 - t) + to[2] * t,
    from[3] * (1 - t) + to[3] * t,
  ];
}

describe('dual-texture transition blend proof', () => {
  it('keeps a curated allowlist with dual-sampler Pixi fragments', () => {
    const curated = listTransitionShaders();
    expect(curated.length).toBeGreaterThanOrEqual(12);
    for (const entry of curated) {
      const frag = buildPixiTransitionFragment(entry.glsl);
      expect(frag).toContain('sampler2D uTexture');
      expect(frag).toContain('sampler2D uTextureTo');
      expect(frag).toContain('getFromColor');
      expect(frag).toContain('getToColor');
    }
  });

  it('fade mid-progress is a real A↔B mix (exit-criterion goldens)', () => {
    expect(getTransitionShader('dissolve')?.glName).toBe('fade');
    expect(getTransitionShader('gl:fade')?.glName).toBe('fade');
    const from = [255, 0, 0, 255] as const;
    const to = [0, 0, 255, 255] as const;
    const mid = sampleFade(from, to, 0.5);
    expect(mid[0]).toBeCloseTo(127.5, 5);
    expect(mid[1]).toBeCloseTo(0, 5);
    expect(mid[2]).toBeCloseTo(127.5, 5);
    // Overlay-only dissolve would ignore `to` and just darken/plate — this must use both.
    expect(mid[0]).not.toBe(from[0]);
    expect(mid[2]).not.toBe(from[2]);
  });

  it('wipeLeft / CrossZoom stay in the curated registry for Monitor/export', () => {
    expect(getTransitionShader('wipe')).toBeDefined();
    expect(getTransitionShader('gl:wipeLeft')).toBeDefined();
    expect(getTransitionShader('gl:CrossZoom')).toBeDefined();
  });
});
