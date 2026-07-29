import type { AnimationCurveV1 } from '@joy-media/project-schema';
import type { EffectParamValue } from '../types.js';

export interface JoyEffectPresetV1 {
  readonly kind: 'joy-effect-preset';
  readonly version: 1;
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly collection?: 'classic' | 'pixel-bw';
  readonly effects: readonly {
    readonly effectId: string;
    readonly enabled: boolean;
    readonly params: Readonly<Record<string, EffectParamValue>>;
    readonly animations?: Readonly<Partial<Record<string, AnimationCurveV1>>>;
  }[];
  readonly createdAt?: string;
}

export const BUILTIN_PRESETS: readonly JoyEffectPresetV1[] = [
  {
    kind: 'joy-effect-preset',
    version: 1,
    id: 'cinematic-contrast',
    name: 'Cinematic Contrast',
    description: 'Deep contrast with a slight warm tone.',
    effects: [
      {
        effectId: 'brightness-contrast',
        enabled: true,
        params: { brightness: -0.05, contrast: 0.15 },
      },
      { effectId: 'sepia', enabled: true, params: { amount: 0.15 } },
      { effectId: 'vignette', enabled: true, params: { amount: 0.3 } },
    ],
  },
  {
    kind: 'joy-effect-preset',
    version: 1,
    id: 'soft-portrait',
    name: 'Soft Portrait',
    description: 'Gentle blur and warm glow for portraits.',
    effects: [
      { effectId: 'gaussian-blur', enabled: true, params: { amount: 2 } },
      {
        effectId: 'brightness-contrast',
        enabled: true,
        params: { brightness: 0.05, contrast: -0.05 },
      },
      { effectId: 'glow', enabled: true, params: { amount: 0.2 } },
    ],
  },
  {
    kind: 'joy-effect-preset',
    version: 1,
    id: 'vintage-fade',
    name: 'Vintage Fade',
    description: 'Faded colors, sepia tone, grain.',
    effects: [
      { effectId: 'sepia', enabled: true, params: { amount: 0.6 } },
      { effectId: 'vignette', enabled: true, params: { amount: 0.4 } },
      { effectId: 'noise', enabled: true, params: { amount: 0.15 } },
      {
        effectId: 'brightness-contrast',
        enabled: true,
        params: { brightness: 0.02, contrast: -0.1 },
      },
    ],
  },
  {
    kind: 'joy-effect-preset',
    version: 1,
    id: 'neon-glow',
    name: 'Neon Glow',
    description: 'Bright bloom and high saturation.',
    effects: [
      { effectId: 'bloom', enabled: true, params: { amount: 0.6, threshold: 0.4 } },
      { effectId: 'vibrance', enabled: true, params: { amount: 0.4 } },
      {
        effectId: 'brightness-contrast',
        enabled: true,
        params: { brightness: 0.05, contrast: 0.1 },
      },
    ],
  },
  {
    kind: 'joy-effect-preset',
    version: 1,
    id: 'clean-product',
    name: 'Clean Product',
    description: 'Sharp, bright, high contrast for product shots.',
    effects: [
      {
        effectId: 'brightness-contrast',
        enabled: true,
        params: { brightness: 0.1, contrast: 0.2 },
      },
      { effectId: 'vibrance', enabled: true, params: { amount: 0.2 } },
    ],
  },
  {
    kind: 'joy-effect-preset',
    version: 1,
    id: 'vhs-light',
    name: 'VHS Light',
    description: 'Slight pixelation, noise, and washed-out colors.',
    effects: [
      { effectId: 'pixelate', enabled: true, params: { blockSize: 4 } },
      { effectId: 'noise', enabled: true, params: { amount: 0.1 } },
      { effectId: 'hue-saturation', enabled: true, params: { hue: 0.02, saturation: -0.2 } },
    ],
  },
  {
    kind: 'joy-effect-preset',
    version: 1,
    id: 'bw-punch',
    name: 'Black & White Punch',
    description: 'High contrast black and white.',
    effects: [
      { effectId: 'hue-saturation', enabled: true, params: { hue: 0, saturation: -1 } },
      { effectId: 'brightness-contrast', enabled: true, params: { brightness: 0, contrast: 0.3 } },
    ],
  },
  {
    kind: 'joy-effect-preset',
    version: 1,
    id: 'warm-food',
    name: 'Warm Food',
    description: 'Warm tone and vibrance for food content.',
    effects: [
      { effectId: 'sepia', enabled: true, params: { amount: 0.25 } },
      { effectId: 'vibrance', enabled: true, params: { amount: 0.5 } },
      {
        effectId: 'brightness-contrast',
        enabled: true,
        params: { brightness: 0.08, contrast: 0.1 },
      },
    ],
  },
  {
    kind: 'joy-effect-preset',
    version: 1,
    id: 'cool-tech',
    name: 'Cool Tech',
    description: 'Blue-tinted saturation for tech content.',
    effects: [
      { effectId: 'hue-saturation', enabled: true, params: { hue: -0.15, saturation: 0.2 } },
      {
        effectId: 'brightness-contrast',
        enabled: true,
        params: { brightness: 0.03, contrast: 0.15 },
      },
    ],
  },
  {
    kind: 'joy-effect-preset',
    version: 1,
    id: 'dreamy-bloom',
    name: 'Dreamy Bloom',
    description: 'Heavy bloom and soft blur for dream sequences.',
    effects: [
      { effectId: 'bloom', enabled: true, params: { amount: 0.8, threshold: 0.3 } },
      { effectId: 'gaussian-blur', enabled: true, params: { amount: 3 } },
      { effectId: 'glow', enabled: true, params: { amount: 0.4 } },
    ],
  },
  {
    kind: 'joy-effect-preset',
    version: 1,
    id: 'newsprint-portrait',
    name: 'Newsprint Portrait',
    description: 'Angled monochrome dots with the character of a printed editorial portrait.',
    collection: 'pixel-bw',
    effects: [
      {
        effectId: 'halftone',
        enabled: true,
        params: { cellSize: 8, angle: 22.5, dotScale: 1.08, shape: 0, colorMode: 0, invert: 0 },
      },
    ],
  },
  {
    kind: 'joy-effect-preset',
    version: 1,
    id: 'bayer-noir',
    name: 'Bayer Noir',
    description: 'Hard two-tone ordered dithering with stable, graphic pixels.',
    collection: 'pixel-bw',
    effects: [
      {
        effectId: 'monochrome',
        enabled: true,
        params: { threshold: 0.48, softness: 0.12, contrast: 0.25, invert: 0 },
      },
      {
        effectId: 'bayer-dither',
        enabled: true,
        params: { cellSize: 2, levels: 2, strength: 1, colorMode: 0, invert: 0 },
      },
    ],
  },
  {
    kind: 'joy-effect-preset',
    version: 1,
    id: 'lcd-dither',
    name: 'LCD Dither',
    description: 'A compact color dither reminiscent of early display panels.',
    collection: 'pixel-bw',
    effects: [
      {
        effectId: 'bayer-dither',
        enabled: true,
        params: { cellSize: 3, levels: 4, strength: 0.85, colorMode: 1, invert: 0 },
      },
      {
        effectId: 'brightness-contrast',
        enabled: true,
        params: { brightness: 0.02, contrast: 0.12 },
      },
    ],
  },
  {
    kind: 'joy-effect-preset',
    version: 1,
    id: 'topographic-ink',
    name: 'Topographic Ink',
    description: 'Dense terrain bands reinforced by source edges.',
    collection: 'pixel-bw',
    effects: [
      {
        effectId: 'contour-map',
        enabled: true,
        params: { spacing: 11, thickness: 0.13, edgeBoost: 0.95, detail: 1, invert: 0 },
      },
    ],
  },
  {
    kind: 'joy-effect-preset',
    version: 1,
    id: 'field-notes',
    name: 'Field Notes',
    description: 'Warm paper, fine contour lines, and an archival diagram feel.',
    collection: 'pixel-bw',
    effects: [
      {
        effectId: 'contour-map',
        enabled: true,
        params: { spacing: 7, thickness: 0.09, edgeBoost: 0.65, detail: 2, invert: 0 },
      },
      { effectId: 'sepia', enabled: true, params: { amount: 0.45 } },
      {
        effectId: 'brightness-contrast',
        enabled: true,
        params: { brightness: 0.08, contrast: -0.08 },
      },
    ],
  },
  {
    kind: 'joy-effect-preset',
    version: 1,
    id: 'glyph-code',
    name: 'Glyph Code',
    description: 'The image rebuilt as a tight green procedural code matrix.',
    collection: 'pixel-bw',
    effects: [
      {
        effectId: 'glyph-matrix',
        enabled: true,
        params: {
          cellWidth: 9,
          cellHeight: 14,
          density: 1.15,
          contrast: 0.4,
          style: 1,
          flow: 0,
          foregroundR: 94,
          foregroundG: 255,
          foregroundB: 148,
          colorMode: 0,
          invert: 0,
        },
      },
    ],
  },
  {
    kind: 'joy-effect-preset',
    version: 1,
    id: 'matrix-rain',
    name: 'Matrix Rain',
    description: 'Tall segmented code marks with animated vertical flow.',
    collection: 'pixel-bw',
    effects: [
      {
        effectId: 'glyph-matrix',
        enabled: true,
        params: {
          cellWidth: 8,
          cellHeight: 18,
          density: 1.35,
          contrast: 0.65,
          style: 2,
          flow: 0.72,
          foregroundR: 65,
          foregroundG: 255,
          foregroundB: 118,
          colorMode: 0,
          invert: 0,
        },
        animations: {
          flow: {
            keyframes: [
              { timeUs: 0, value: 0, interpolation: 'linear' },
              { timeUs: 4_000_000, value: 1, interpolation: 'linear' },
            ],
          },
        },
      },
    ],
  },
  {
    kind: 'joy-effect-preset',
    version: 1,
    id: 'symbol-matrix',
    name: 'Symbol Matrix',
    description: 'Bright dot glyphs on black with a clean monochrome signal.',
    collection: 'pixel-bw',
    effects: [
      {
        effectId: 'glyph-matrix',
        enabled: true,
        params: {
          cellWidth: 12,
          cellHeight: 12,
          density: 0.9,
          contrast: 0.15,
          style: 0,
          flow: 0,
          foregroundR: 245,
          foregroundG: 245,
          foregroundB: 235,
          colorMode: 0,
          invert: 0,
        },
      },
    ],
  },
  {
    kind: 'joy-effect-preset',
    version: 1,
    id: 'contour-type',
    name: 'Contour Type',
    description: 'Topographic linework translated into a sparse glyph field.',
    collection: 'pixel-bw',
    effects: [
      {
        effectId: 'contour-map',
        enabled: true,
        params: { spacing: 8, thickness: 0.1, edgeBoost: 0.8, detail: 1, invert: 1 },
      },
      {
        effectId: 'glyph-matrix',
        enabled: true,
        params: {
          cellWidth: 10,
          cellHeight: 15,
          density: 0.8,
          contrast: 0.5,
          style: 2,
          flow: 0,
          foregroundR: 240,
          foregroundG: 238,
          foregroundB: 218,
          colorMode: 0,
          invert: 0,
        },
      },
    ],
  },
  {
    kind: 'joy-effect-preset',
    version: 1,
    id: 'scatter-poster',
    name: 'Scatter Poster',
    description: 'Offset block samples and reduced color for a fractured poster look.',
    collection: 'pixel-bw',
    effects: [
      {
        effectId: 'scatter-mosaic',
        enabled: true,
        params: { cellSize: 14, scatter: 1.15, levels: 6, colorMode: 1, seed: 4.2 },
      },
      { effectId: 'posterize', enabled: true, params: { levels: 5 } },
    ],
  },
  {
    kind: 'joy-effect-preset',
    version: 1,
    id: 'tone-circles',
    name: 'Tone Circles',
    description: 'Bold black circles scaled by the source luminance.',
    collection: 'pixel-bw',
    effects: [
      {
        effectId: 'tone-geometry',
        enabled: true,
        params: { cellSize: 13, scale: 1.05, angle: 0, shape: 0, colorMode: 0, invert: 0 },
      },
    ],
  },
  {
    kind: 'joy-effect-preset',
    version: 1,
    id: 'barcode-portrait',
    name: 'Barcode Portrait',
    description: 'Rotated line geometry turns the frame into graphic engraving.',
    collection: 'pixel-bw',
    effects: [
      {
        effectId: 'tone-geometry',
        enabled: true,
        params: { cellSize: 10, scale: 1.1, angle: 35, shape: 3, colorMode: 0, invert: 0 },
      },
    ],
  },
  {
    kind: 'joy-effect-preset',
    version: 1,
    id: 'pixel-melt',
    name: 'Pixel Melt',
    description: 'Vertical luminance-gated sorting for liquid digital streaks.',
    collection: 'pixel-bw',
    effects: [
      {
        effectId: 'pixel-sort',
        enabled: true,
        params: {
          direction: 1,
          lowThreshold: 0.14,
          highThreshold: 0.88,
          length: 110,
          intensity: 1.1,
          colorMode: 1,
        },
        animations: {
          length: {
            keyframes: [
              { timeUs: 0, value: 35, interpolation: 'eased' },
              { timeUs: 2_000_000, value: 145, interpolation: 'eased' },
              { timeUs: 4_000_000, value: 70, interpolation: 'eased' },
            ],
          },
        },
      },
    ],
  },
  {
    kind: 'joy-effect-preset',
    version: 1,
    id: 'xerox-punk',
    name: 'Xerox Punk',
    description: 'Crushed threshold tones and grain for a photocopied zine finish.',
    collection: 'pixel-bw',
    effects: [
      {
        effectId: 'monochrome',
        enabled: true,
        params: { threshold: 0.52, softness: 0.015, contrast: 1.25, invert: 0 },
      },
      { effectId: 'noise', enabled: true, params: { amount: 0.12 } },
    ],
  },
  {
    kind: 'joy-effect-preset',
    version: 1,
    id: 'riso-red',
    name: 'Riso Red',
    description: 'Open halftone dots washed with a warm risograph-style ink.',
    collection: 'pixel-bw',
    effects: [
      {
        effectId: 'halftone',
        enabled: true,
        params: { cellSize: 9, angle: -18, dotScale: 0.95, shape: 0, colorMode: 0, invert: 0 },
      },
      {
        effectId: 'color-overlay',
        enabled: true,
        params: { r: 235, g: 48, b: 42, opacity: 0.48 },
      },
    ],
  },
  {
    kind: 'joy-effect-preset',
    version: 1,
    id: 'pixel-poster',
    name: 'Pixel Poster',
    description: 'Hard sampled blocks and reduced color levels for a bold digital poster.',
    collection: 'pixel-bw',
    effects: [
      { effectId: 'pixelate', enabled: true, params: { blockSize: 9 } },
      { effectId: 'posterize', enabled: true, params: { levels: 5 } },
      {
        effectId: 'brightness-contrast',
        enabled: true,
        params: { brightness: 0.02, contrast: 0.18 },
      },
    ],
  },
];

export function findPreset(id: string): JoyEffectPresetV1 | undefined {
  return BUILTIN_PRESETS.find((p) => p.id === id);
}

export function listPresets(): readonly JoyEffectPresetV1[] {
  return BUILTIN_PRESETS;
}
