import { describe, expect, it } from 'vitest';
import type { EffectInstanceIR } from '@joy-media/render-ir';
import { applyHeadlessEffects } from './index.js';

const CREATIVE_EFFECTS: readonly EffectInstanceIR[] = [
  {
    id: 'mono',
    kind: 'monochrome',
    enabled: true,
    params: { threshold: 0.5, softness: 0.04, contrast: 0.2, invert: 0 },
  },
  {
    id: 'dither',
    kind: 'bayer-dither',
    enabled: true,
    params: { cellSize: 2, levels: 2, strength: 1, colorMode: 0, invert: 0 },
  },
  {
    id: 'halftone',
    kind: 'halftone',
    enabled: true,
    params: { cellSize: 8, angle: 22.5, dotScale: 1, shape: 0, colorMode: 0, invert: 0 },
  },
  {
    id: 'contour',
    kind: 'contour-map',
    enabled: true,
    params: { spacing: 9, thickness: 0.16, edgeBoost: 0.75, detail: 1, invert: 0 },
  },
  {
    id: 'glyph',
    kind: 'glyph-matrix',
    enabled: true,
    params: {
      cellWidth: 8,
      cellHeight: 12,
      density: 1,
      contrast: 0.3,
      style: 1,
      flow: 0.4,
      foregroundR: 110,
      foregroundG: 255,
      foregroundB: 155,
      colorMode: 0,
      invert: 0,
    },
  },
  {
    id: 'scatter',
    kind: 'scatter-mosaic',
    enabled: true,
    params: { cellSize: 7, scatter: 0.75, levels: 6, colorMode: 1, seed: 3 },
  },
  {
    id: 'geometry',
    kind: 'tone-geometry',
    enabled: true,
    params: { cellSize: 9, scale: 1, angle: 18, shape: 1, colorMode: 0, invert: 0 },
  },
  {
    id: 'sort',
    kind: 'pixel-sort',
    enabled: true,
    params: {
      direction: 1,
      lowThreshold: 0.18,
      highThreshold: 0.9,
      length: 28,
      intensity: 1,
      colorMode: 1,
    },
  },
];

describe('creative pixel and black-and-white effects', () => {
  for (const effect of CREATIVE_EFFECTS) {
    it(`${effect.kind} is applied and deterministic`, () => {
      const original = createGradient(32, 24);
      const first = new Uint8Array(original);
      const second = new Uint8Array(original);

      expect(applyHeadlessEffects(first, 32, 24, [effect])).toEqual([
        { instanceId: effect.id, effectId: effect.kind, status: 'applied' },
      ]);
      applyHeadlessEffects(second, 32, 24, [effect]);

      expect(first).not.toEqual(original);
      expect(first).toEqual(second);
    });
  }
});

function createGradient(width: number, height: number): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4;
      pixels[index] = Math.round((x / (width - 1)) * 255);
      pixels[index + 1] = Math.round((y / (height - 1)) * 255);
      pixels[index + 2] = Math.round((((x * 3 + y * 5) % width) / (width - 1)) * 255);
      pixels[index + 3] = 255;
    }
  }
  return pixels;
}
