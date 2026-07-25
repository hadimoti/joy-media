import type { EffectParamValue } from '../types.js';

export interface JoyEffectPresetV1 {
  readonly kind: 'joy-effect-preset';
  readonly version: 1;
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly effects: readonly {
    readonly effectId: string;
    readonly enabled: boolean;
    readonly params: Readonly<Record<string, EffectParamValue>>;
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
      { effectId: 'brightness-contrast', enabled: true, params: { brightness: -0.05, contrast: 0.15 } },
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
      { effectId: 'brightness-contrast', enabled: true, params: { brightness: 0.05, contrast: -0.05 } },
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
      { effectId: 'brightness-contrast', enabled: true, params: { brightness: 0.02, contrast: -0.1 } },
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
      { effectId: 'brightness-contrast', enabled: true, params: { brightness: 0.05, contrast: 0.1 } },
    ],
  },
  {
    kind: 'joy-effect-preset',
    version: 1,
    id: 'clean-product',
    name: 'Clean Product',
    description: 'Sharp, bright, high contrast for product shots.',
    effects: [
      { effectId: 'brightness-contrast', enabled: true, params: { brightness: 0.1, contrast: 0.2 } },
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
      { effectId: 'brightness-contrast', enabled: true, params: { brightness: 0.08, contrast: 0.1 } },
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
      { effectId: 'brightness-contrast', enabled: true, params: { brightness: 0.03, contrast: 0.15 } },
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
];

export function findPreset(id: string): JoyEffectPresetV1 | undefined {
  return BUILTIN_PRESETS.find((p) => p.id === id);
}

export function listPresets(): readonly JoyEffectPresetV1[] {
  return BUILTIN_PRESETS;
}
