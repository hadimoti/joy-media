import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EffectInstanceIR } from '@joy-media/render-ir';
import type { ColorMatrixFilter, Filter } from 'pixi.js';
import { createCreativeEffectFilter } from './creative-effects.js';
import { buildPixiEffectFilters } from './effects-pixi.js';

// Pixi probes the GL precision through a canvas on first GlProgram use. Node has no
// document, so a stub that yields no context keeps these checks purely textual.
beforeAll(() => {
  vi.stubGlobal('document', {
    createElement: () => ({ getContext: () => null }),
  });
});

afterAll(() => vi.unstubAllGlobals());

/** Creative-effects kinds built from creative-effects.ts shader strings. */
const CREATIVE_KINDS = [
  'pixelate',
  'mosaic',
  'posterize',
  'monochrome',
  'bayer-dither',
  'halftone',
  'contour-map',
  'glyph-matrix',
  'scatter-mosaic',
  'tone-geometry',
  'pixel-sort',
  'zoom-blur',
  'radial-blur',
  'tilt-shift',
] as const;

/** Shader-backed kinds built in effects-pixi.ts (the nine new filters plus vignette). */
const PIXI_SHADER_KINDS = [
  'color-overlay',
  'curves',
  'bulge',
  'twist',
  'ripple',
  'crt',
  'edge-detect',
  'emboss',
  'unsharp-mask',
  'vignette',
  'bloom',
] as const;

const IDENTITY_5X4 = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0];

function instance(kind: string, params: Record<string, number> = {}): EffectInstanceIR {
  return { id: `fx-${kind}`, kind, enabled: true, params };
}

function asColorMatrix(filter: Filter | undefined): readonly number[] {
  expect(filter).toBeDefined();
  return Array.from((filter as ColorMatrixFilter).matrix);
}

describe('effect shader precision contract', () => {
  // Pixi prepends its own `precision` line to each shader (these sources start with a
  // newline), with mediump for the fragment stage. The `highp` line in the fragment stage
  // keeps `uInputSize`, which both stages declare, at one precision. Without it the preview
  // rendered blank (observed in the SwiftShader preview build; the mechanism is inferred).
  // The vertex check passes without the source line because Pixi adds highp there.
  it.each(CREATIVE_KINDS)(
    'creative effect "%s" declares float precision in both stages',
    (kind) => {
      const filter = createCreativeEffectFilter(instance(kind));
      expect(filter, kind).toBeDefined();
      const { vertex, fragment } = filter!.glProgram;
      expect(vertex, `${kind} vertex`).toMatch(/precision highp float;/);
      expect(fragment, `${kind} fragment`).toMatch(/precision highp float;/);
    },
  );

  it.each(PIXI_SHADER_KINDS)(
    'shader effect "%s" declares float precision in both stages',
    (kind) => {
      const filters = buildPixiEffectFilters([instance(kind)]);
      expect(filters.length, kind).toBeGreaterThan(0);
      for (const filter of filters) {
        expect(filter.glProgram.vertex, `${kind} vertex`).toMatch(/precision highp float;/);
        expect(filter.glProgram.fragment, `${kind} fragment`).toMatch(/precision highp float;/);
      }
    },
  );
});

describe('brightness-contrast matrix', () => {
  it('is the exact identity matrix at brightness 0 and contrast 0', () => {
    const filters = buildPixiEffectFilters([
      instance('brightness-contrast', { brightness: 0, contrast: 0 }),
    ]);
    expect(filters).toHaveLength(1);
    expect(asColorMatrix(filters[0])).toEqual(IDENTITY_5X4);
  });

  it('treats a missing brightness or contrast param as the neutral 0', () => {
    expect(asColorMatrix(buildPixiEffectFilters([instance('brightness-contrast')])[0])).toEqual(
      IDENTITY_5X4,
    );
  });

  it('keeps contrast centred on mid-grey instead of multiplying toward black', () => {
    // contrast +1 doubles the slope around 0.5, so the mid-grey row maps to itself.
    const matrix = asColorMatrix(
      buildPixiEffectFilters([instance('brightness-contrast', { brightness: 0, contrast: 1 })])[0],
    );
    expect(matrix[0]).toBe(2);
    expect(matrix[4]).toBeCloseTo(-0.5, 10);
    expect(0.5 * matrix[0]! + matrix[4]!).toBeCloseTo(0.5, 10);
  });
});
