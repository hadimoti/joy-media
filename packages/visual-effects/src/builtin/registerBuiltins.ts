import { registerEffect } from '../EffectRegistry.js';
import type { EffectDescriptor } from '../types.js';
import { CREATIVE_PIXEL_DESCRIPTORS } from './creativePixel.js';

export const brightnessContrastDescriptor: EffectDescriptor = {
  id: 'brightness-contrast',
  label: 'Brightness / Contrast',
  category: 'color',
  description: 'Adjust the brightness and contrast of a clip.',
  params: [
    {
      key: 'brightness',
      label: 'Brightness',
      type: 'number',
      defaultValue: 0,
      min: -1,
      max: 1,
      step: 0.01,
      unit: '',
      animatable: true,
    },
    {
      key: 'contrast',
      label: 'Contrast',
      type: 'number',
      defaultValue: 0,
      min: -1,
      max: 1,
      step: 0.01,
      unit: '',
      animatable: true,
    },
  ],
  tags: ['color', 'brightness', 'contrast', 'grade'],
  backend: { pixiPreview: true, headless: true, ffmpeg: true, deterministic: true },
  cost: 'low',
};

export const hueSaturationDescriptor: EffectDescriptor = {
  id: 'hue-saturation',
  label: 'Hue / Saturation',
  category: 'color',
  description: 'Shift the hue and adjust saturation.',
  params: [
    {
      key: 'hue',
      label: 'Hue',
      type: 'number',
      defaultValue: 0,
      min: -1,
      max: 1,
      step: 0.01,
      unit: 'turn',
      animatable: true,
    },
    {
      key: 'saturation',
      label: 'Saturation',
      type: 'number',
      defaultValue: 0,
      min: -1,
      max: 1,
      step: 0.01,
      animatable: true,
    },
  ],
  tags: ['color', 'hue', 'saturation'],
  backend: { pixiPreview: true, headless: true, ffmpeg: true, deterministic: true },
  cost: 'low',
};

export const vibranceDescriptor: EffectDescriptor = {
  id: 'vibrance',
  label: 'Vibrance',
  category: 'color',
  description: 'Boost muted colors while sparing already-saturated tones.',
  params: [
    {
      key: 'amount',
      label: 'Amount',
      type: 'number',
      defaultValue: 0,
      min: -1,
      max: 1,
      step: 0.01,
      animatable: true,
    },
  ],
  tags: ['color', 'vibrance', 'grade'],
  backend: { pixiPreview: true, headless: true, ffmpeg: false, deterministic: true },
  cost: 'low',
};

export const vignetteDescriptor: EffectDescriptor = {
  id: 'vignette',
  label: 'Vignette',
  category: 'artistic',
  description: 'Darken or brighten the edges of the frame.',
  params: [
    {
      key: 'amount',
      label: 'Amount',
      type: 'number',
      defaultValue: 0.35,
      min: 0,
      max: 1,
      step: 0.01,
      animatable: true,
    },
  ],
  tags: ['artistic', 'vignette', 'frame'],
  backend: { pixiPreview: true, headless: false, ffmpeg: false, deterministic: true },
  cost: 'medium',
};

export const sepiaDescriptor: EffectDescriptor = {
  id: 'sepia',
  label: 'Sepia',
  category: 'color',
  description: 'Apply a warm sepia tone to the clip.',
  params: [
    {
      key: 'amount',
      label: 'Amount',
      type: 'number',
      defaultValue: 0.5,
      min: 0,
      max: 1,
      step: 0.01,
      animatable: true,
    },
  ],
  tags: ['color', 'sepia', 'vintage'],
  backend: { pixiPreview: true, headless: true, ffmpeg: true, deterministic: true },
  cost: 'low',
};

export const gaussianBlurDescriptor: EffectDescriptor = {
  id: 'gaussian-blur',
  label: 'Gaussian Blur',
  category: 'blur',
  description: 'Blur the clip with a Gaussian kernel.',
  params: [
    {
      key: 'amount',
      label: 'Strength',
      type: 'number',
      defaultValue: 4,
      min: 0,
      max: 40,
      step: 0.1,
      animatable: true,
    },
  ],
  tags: ['blur', 'gaussian', 'soften'],
  backend: { pixiPreview: true, headless: true, ffmpeg: true, deterministic: true },
  cost: 'medium',
};

export const bloomDescriptor: EffectDescriptor = {
  id: 'bloom',
  label: 'Bloom',
  category: 'blur',
  description: 'Add a soft glow around bright areas.',
  params: [
    {
      key: 'amount',
      label: 'Intensity',
      type: 'number',
      defaultValue: 0.4,
      min: 0,
      max: 1,
      step: 0.01,
      animatable: true,
    },
    {
      key: 'threshold',
      label: 'Threshold',
      type: 'number',
      defaultValue: 0.6,
      min: 0,
      max: 1,
      step: 0.01,
      animatable: true,
    },
  ],
  tags: ['blur', 'bloom', 'glow', 'light'],
  backend: { pixiPreview: true, headless: false, ffmpeg: false, deterministic: true },
  cost: 'medium',
};

export const dropShadowDescriptor: EffectDescriptor = {
  id: 'drop-shadow',
  label: 'Drop Shadow',
  category: 'depth',
  description: 'Add a shadow behind the visual object.',
  params: [
    {
      key: 'opacity',
      label: 'Opacity',
      type: 'number',
      defaultValue: 0.5,
      min: 0,
      max: 1,
      step: 0.01,
      animatable: true,
    },
    {
      key: 'distance',
      label: 'Distance',
      type: 'number',
      defaultValue: 8,
      min: 0,
      max: 40,
      step: 1,
      animatable: true,
    },
  ],
  tags: ['depth', 'shadow', 'elevation'],
  backend: { pixiPreview: true, headless: false, ffmpeg: false, deterministic: true },
  cost: 'medium',
};

export const glowDescriptor: EffectDescriptor = {
  id: 'glow',
  label: 'Glow',
  category: 'blur',
  description: 'Add a luminous glow around the visual object.',
  params: [
    {
      key: 'amount',
      label: 'Intensity',
      type: 'number',
      defaultValue: 0.4,
      min: 0,
      max: 1,
      step: 0.01,
      animatable: true,
    },
  ],
  tags: ['blur', 'glow', 'light'],
  backend: { pixiPreview: true, headless: false, ffmpeg: false, deterministic: true },
  cost: 'medium',
};

export const noiseDescriptor: EffectDescriptor = {
  id: 'noise',
  label: 'Film Grain / Noise',
  category: 'stylize',
  description: 'Add film grain or noise to the clip.',
  params: [
    {
      key: 'amount',
      label: 'Amount',
      type: 'number',
      defaultValue: 0.2,
      min: 0.01,
      max: 1,
      step: 0.01,
      animatable: true,
    },
  ],
  tags: ['stylize', 'noise', 'grain', 'film'],
  backend: {
    pixiPreview: true,
    headless: true,
    ffmpeg: false,
    deterministic: false,
    notes: 'Seed-based; non-deterministic without fixed seed',
  },
  cost: 'medium',
};

export const posterizeDescriptor: EffectDescriptor = {
  id: 'posterize',
  label: 'Posterize',
  category: 'artistic',
  description: 'Reduce the number of color levels for a poster-like effect.',
  params: [
    {
      key: 'levels',
      label: 'Levels',
      type: 'number',
      defaultValue: 8,
      min: 2,
      max: 32,
      step: 1,
      animatable: true,
    },
  ],
  tags: ['artistic', 'posterize', 'stylize'],
  backend: { pixiPreview: true, headless: true, ffmpeg: false, deterministic: true },
  cost: 'low',
};

export const pixelateDescriptor: EffectDescriptor = {
  id: 'pixelate',
  label: 'Pixelate',
  category: 'stylize',
  description: 'Pixelate the clip into blocks.',
  params: [
    {
      key: 'blockSize',
      label: 'Block Size',
      type: 'number',
      defaultValue: 8,
      min: 2,
      max: 64,
      step: 1,
      animatable: true,
    },
  ],
  tags: ['stylize', 'pixelate', 'mosaic'],
  backend: { pixiPreview: true, headless: true, ffmpeg: false, deterministic: true },
  cost: 'medium',
};

// Batch B — Color
export const colorOverlayDescriptor: EffectDescriptor = {
  id: 'color-overlay',
  label: 'Color Overlay',
  category: 'color',
  description: 'Tint the clip with a solid color.',
  params: [
    {
      key: 'r',
      label: 'Red',
      type: 'number',
      defaultValue: 255,
      min: 0,
      max: 255,
      step: 1,
      animatable: true,
    },
    {
      key: 'g',
      label: 'Green',
      type: 'number',
      defaultValue: 0,
      min: 0,
      max: 255,
      step: 1,
      animatable: true,
    },
    {
      key: 'b',
      label: 'Blue',
      type: 'number',
      defaultValue: 0,
      min: 0,
      max: 255,
      step: 1,
      animatable: true,
    },
    {
      key: 'opacity',
      label: 'Opacity',
      type: 'number',
      defaultValue: 0.3,
      min: 0,
      max: 1,
      step: 0.01,
      animatable: true,
    },
  ],
  tags: ['color', 'overlay', 'tint', 'grade'],
  backend: { pixiPreview: true, headless: true, ffmpeg: false, deterministic: true },
  cost: 'low',
};

export const curvesDescriptor: EffectDescriptor = {
  id: 'curves',
  label: 'Curves',
  category: 'color',
  description: 'RGB curves adjustment.',
  params: [
    {
      key: 'shadows',
      label: 'Shadows',
      type: 'number',
      defaultValue: 0,
      min: -0.5,
      max: 0.5,
      step: 0.01,
      animatable: true,
    },
    {
      key: 'midtones',
      label: 'Midtones',
      type: 'number',
      defaultValue: 0,
      min: -0.5,
      max: 0.5,
      step: 0.01,
      animatable: true,
    },
    {
      key: 'highlights',
      label: 'Highlights',
      type: 'number',
      defaultValue: 0,
      min: -0.5,
      max: 0.5,
      step: 0.01,
      animatable: true,
    },
  ],
  tags: ['color', 'curves', 'grade'],
  backend: { pixiPreview: true, headless: false, ffmpeg: false, deterministic: true },
  cost: 'medium',
};

// Batch B — Blur and depth
export const zoomBlurDescriptor: EffectDescriptor = {
  id: 'zoom-blur',
  label: 'Zoom Blur',
  category: 'blur',
  description: 'Radial zoom-like blur from center.',
  params: [
    {
      key: 'amount',
      label: 'Strength',
      type: 'number',
      defaultValue: 6,
      min: 0,
      max: 20,
      step: 0.1,
      animatable: true,
    },
  ],
  tags: ['blur', 'zoom', 'motion'],
  backend: { pixiPreview: true, headless: false, ffmpeg: false, deterministic: true },
  cost: 'medium',
};

export const radialBlurDescriptor: EffectDescriptor = {
  id: 'radial-blur',
  label: 'Radial Blur',
  category: 'blur',
  description: 'Circular blur radiating from center.',
  params: [
    {
      key: 'amount',
      label: 'Strength',
      type: 'number',
      defaultValue: 5,
      min: 0,
      max: 20,
      step: 0.1,
      animatable: true,
    },
  ],
  tags: ['blur', 'radial', 'circle'],
  backend: { pixiPreview: true, headless: false, ffmpeg: false, deterministic: true },
  cost: 'medium',
};

export const tiltShiftDescriptor: EffectDescriptor = {
  id: 'tilt-shift',
  label: 'Tilt Shift',
  category: 'blur',
  description: 'Miniature effect with top/bottom blur.',
  params: [
    {
      key: 'amount',
      label: 'Blur',
      type: 'number',
      defaultValue: 8,
      min: 0,
      max: 20,
      step: 0.1,
      animatable: true,
    },
    {
      key: 'focusY',
      label: 'Focus Y',
      type: 'number',
      defaultValue: 0.5,
      min: 0,
      max: 1,
      step: 0.01,
      animatable: true,
    },
    {
      key: 'focusHeight',
      label: 'Focus Height',
      type: 'number',
      defaultValue: 0.3,
      min: 0.05,
      max: 1,
      step: 0.01,
      animatable: true,
    },
  ],
  tags: ['blur', 'tilt-shift', 'miniature'],
  backend: { pixiPreview: true, headless: false, ffmpeg: false, deterministic: true },
  cost: 'high',
};

// Batch C — Distort
export const bulgeDescriptor: EffectDescriptor = {
  id: 'bulge',
  label: 'Bulge / Pinch',
  category: 'distort',
  description: 'Bulge or pinch the image from center.',
  params: [
    {
      key: 'amount',
      label: 'Strength',
      type: 'number',
      defaultValue: 0,
      min: -1,
      max: 1,
      step: 0.01,
      animatable: true,
    },
    {
      key: 'radius',
      label: 'Radius',
      type: 'number',
      defaultValue: 0.4,
      min: 0.05,
      max: 1,
      step: 0.01,
      animatable: true,
    },
  ],
  tags: ['distort', 'bulge', 'pinch', 'warp'],
  backend: { pixiPreview: true, headless: false, ffmpeg: false, deterministic: true },
  cost: 'medium',
};

export const twistDescriptor: EffectDescriptor = {
  id: 'twist',
  label: 'Twist',
  category: 'distort',
  description: 'Twist the image around center.',
  params: [
    {
      key: 'angle',
      label: 'Angle',
      type: 'number',
      defaultValue: 0,
      min: -2,
      max: 2,
      step: 0.01,
      animatable: true,
    },
    {
      key: 'radius',
      label: 'Radius',
      type: 'number',
      defaultValue: 0.5,
      min: 0.05,
      max: 1,
      step: 0.01,
      animatable: true,
    },
  ],
  tags: ['distort', 'twist', 'swirl'],
  backend: { pixiPreview: true, headless: false, ffmpeg: false, deterministic: true },
  cost: 'medium',
};

export const rippleDescriptor: EffectDescriptor = {
  id: 'ripple',
  label: 'Ripple',
  category: 'distort',
  description: 'Water ripple distortion.',
  params: [
    {
      key: 'amplitude',
      label: 'Amplitude',
      type: 'number',
      defaultValue: 0.02,
      min: 0,
      max: 0.1,
      step: 0.001,
      animatable: true,
    },
    {
      key: 'frequency',
      label: 'Frequency',
      type: 'number',
      defaultValue: 10,
      min: 1,
      max: 30,
      step: 1,
      animatable: true,
    },
  ],
  tags: ['distort', 'ripple', 'wave', 'water'],
  backend: { pixiPreview: true, headless: false, ffmpeg: false, deterministic: true },
  cost: 'high',
};

// Batch D — Artistic / Stylize
export const crtDescriptor: EffectDescriptor = {
  id: 'crt',
  label: 'CRT / Retro',
  category: 'stylize',
  description: 'Old CRT monitor effect with scanlines.',
  params: [
    {
      key: 'scanlines',
      label: 'Scanlines',
      type: 'number',
      defaultValue: 0.5,
      min: 0,
      max: 1,
      step: 0.01,
      animatable: false,
    },
    {
      key: 'noise',
      label: 'Static',
      type: 'number',
      defaultValue: 0.08,
      min: 0,
      max: 0.5,
      step: 0.01,
      animatable: false,
    },
  ],
  tags: ['stylize', 'crt', 'retro', 'vintage'],
  backend: { pixiPreview: true, headless: false, ffmpeg: false, deterministic: true },
  cost: 'medium',
};

export const edgeDetectDescriptor: EffectDescriptor = {
  id: 'edge-detect',
  label: 'Edge Detect',
  category: 'stylize',
  description: 'Highlight edges in the image.',
  params: [
    {
      key: 'threshold',
      label: 'Threshold',
      type: 'number',
      defaultValue: 0.3,
      min: 0.05,
      max: 0.8,
      step: 0.01,
      animatable: true,
    },
  ],
  tags: ['stylize', 'edge', 'outline'],
  backend: { pixiPreview: true, headless: false, ffmpeg: false, deterministic: true },
  cost: 'low',
};

export const embossDescriptor: EffectDescriptor = {
  id: 'emboss',
  label: 'Emboss',
  category: 'stylize',
  description: '3D embossed relief effect.',
  params: [
    {
      key: 'strength',
      label: 'Strength',
      type: 'number',
      defaultValue: 1,
      min: 0.1,
      max: 5,
      step: 0.1,
      animatable: true,
    },
  ],
  tags: ['stylize', 'emboss', 'relief'],
  backend: { pixiPreview: true, headless: false, ffmpeg: false, deterministic: true },
  cost: 'low',
};

export const mosaicDescriptor: EffectDescriptor = {
  id: 'mosaic',
  label: 'Mosaic',
  category: 'stylize',
  description: 'Blocky mosaic effect.',
  params: [
    {
      key: 'blockSize',
      label: 'Block Size',
      type: 'number',
      defaultValue: 16,
      min: 4,
      max: 64,
      step: 4,
      animatable: true,
    },
  ],
  tags: ['stylize', 'mosaic', 'censor'],
  backend: { pixiPreview: true, headless: true, ffmpeg: false, deterministic: true },
  cost: 'low',
};

export const unsharpMaskDescriptor: EffectDescriptor = {
  id: 'unsharp-mask',
  label: 'Unsharp Mask',
  category: 'stylize',
  description: 'Professional sharpening filter.',
  params: [
    {
      key: 'amount',
      label: 'Amount',
      type: 'number',
      defaultValue: 0.5,
      min: 0,
      max: 2,
      step: 0.01,
      animatable: true,
    },
    {
      key: 'radius',
      label: 'Radius',
      type: 'number',
      defaultValue: 1,
      min: 0.5,
      max: 5,
      step: 0.1,
      animatable: false,
    },
    {
      key: 'threshold',
      label: 'Threshold',
      type: 'number',
      defaultValue: 0.05,
      min: 0,
      max: 0.5,
      step: 0.01,
      animatable: false,
    },
  ],
  tags: ['stylize', 'sharpen', 'detail'],
  backend: { pixiPreview: true, headless: true, ffmpeg: false, deterministic: true },
  cost: 'medium',
};

const ALL_DESCRIPTORS: readonly EffectDescriptor[] = [
  brightnessContrastDescriptor,
  hueSaturationDescriptor,
  vibranceDescriptor,
  vignetteDescriptor,
  sepiaDescriptor,
  gaussianBlurDescriptor,
  bloomDescriptor,
  dropShadowDescriptor,
  glowDescriptor,
  noiseDescriptor,
  posterizeDescriptor,
  pixelateDescriptor,
  colorOverlayDescriptor,
  curvesDescriptor,
  zoomBlurDescriptor,
  radialBlurDescriptor,
  tiltShiftDescriptor,
  bulgeDescriptor,
  twistDescriptor,
  rippleDescriptor,
  crtDescriptor,
  edgeDetectDescriptor,
  embossDescriptor,
  mosaicDescriptor,
  unsharpMaskDescriptor,
  ...CREATIVE_PIXEL_DESCRIPTORS,
];

export function registerBuiltins(): void {
  for (const desc of ALL_DESCRIPTORS) {
    registerEffect(desc);
  }
}
