import { registerEffect } from "../EffectRegistry.js";
import type { EffectDescriptor } from "../types.js";

export const brightnessContrastDescriptor: EffectDescriptor = {
  id: "brightness-contrast",
  label: "Brightness / Contrast",
  category: "color",
  description: "Adjust the brightness and contrast of a clip.",
  params: [
    { key: "brightness", label: "Brightness", type: "number", defaultValue: 0, min: -1, max: 1, step: 0.01, unit: "", animatable: true },
    { key: "contrast", label: "Contrast", type: "number", defaultValue: 0, min: -1, max: 1, step: 0.01, unit: "", animatable: true },
  ],
  tags: ["color", "brightness", "contrast", "grade"],
  backend: { pixiPreview: true, headless: true, ffmpeg: true, deterministic: true },
  cost: "low",
};

export const hueSaturationDescriptor: EffectDescriptor = {
  id: "hue-saturation",
  label: "Hue / Saturation",
  category: "color",
  description: "Shift the hue and adjust saturation.",
  params: [
    { key: "hue", label: "Hue", type: "number", defaultValue: 0, min: -1, max: 1, step: 0.01, unit: "turn", animatable: true },
    { key: "saturation", label: "Saturation", type: "number", defaultValue: 0, min: -1, max: 1, step: 0.01, animatable: true },
  ],
  tags: ["color", "hue", "saturation"],
  backend: { pixiPreview: true, headless: true, ffmpeg: true, deterministic: true },
  cost: "low",
};

export const vibranceDescriptor: EffectDescriptor = {
  id: "vibrance",
  label: "Vibrance",
  category: "color",
  description: "Boost muted colors while sparing already-saturated tones.",
  params: [
    { key: "amount", label: "Amount", type: "number", defaultValue: 0, min: -1, max: 1, step: 0.01, animatable: true },
  ],
  tags: ["color", "vibrance", "grade"],
  backend: { pixiPreview: true, headless: true, ffmpeg: false, deterministic: true },
  cost: "low",
};

export const vignetteDescriptor: EffectDescriptor = {
  id: "vignette",
  label: "Vignette",
  category: "artistic",
  description: "Darken or brighten the edges of the frame.",
  params: [
    { key: "amount", label: "Amount", type: "number", defaultValue: 0.35, min: 0, max: 1, step: 0.01, animatable: true },
  ],
  tags: ["artistic", "vignette", "frame"],
  backend: { pixiPreview: true, headless: false, ffmpeg: false, deterministic: true },
  cost: "medium",
};

export const sepiaDescriptor: EffectDescriptor = {
  id: "sepia",
  label: "Sepia",
  category: "color",
  description: "Apply a warm sepia tone to the clip.",
  params: [
    { key: "amount", label: "Amount", type: "number", defaultValue: 0.5, min: 0, max: 1, step: 0.01, animatable: true },
  ],
  tags: ["color", "sepia", "vintage"],
  backend: { pixiPreview: true, headless: true, ffmpeg: true, deterministic: true },
  cost: "low",
};

export const gaussianBlurDescriptor: EffectDescriptor = {
  id: "gaussian-blur",
  label: "Gaussian Blur",
  category: "blur",
  description: "Blur the clip with a Gaussian kernel.",
  params: [
    { key: "amount", label: "Strength", type: "number", defaultValue: 4, min: 0, max: 40, step: 0.1, animatable: true },
  ],
  tags: ["blur", "gaussian", "soften"],
  backend: { pixiPreview: true, headless: true, ffmpeg: true, deterministic: true },
  cost: "medium",
};

export const bloomDescriptor: EffectDescriptor = {
  id: "bloom",
  label: "Bloom",
  category: "blur",
  description: "Add a soft glow around bright areas.",
  params: [
    { key: "amount", label: "Intensity", type: "number", defaultValue: 0.4, min: 0, max: 1, step: 0.01, animatable: true },
    { key: "threshold", label: "Threshold", type: "number", defaultValue: 0.6, min: 0, max: 1, step: 0.01, animatable: true },
  ],
  tags: ["blur", "bloom", "glow", "light"],
  backend: { pixiPreview: true, headless: false, ffmpeg: false, deterministic: true },
  cost: "medium",
};

export const dropShadowDescriptor: EffectDescriptor = {
  id: "drop-shadow",
  label: "Drop Shadow",
  category: "depth",
  description: "Add a shadow behind the visual object.",
  params: [
    { key: "opacity", label: "Opacity", type: "number", defaultValue: 0.5, min: 0, max: 1, step: 0.01, animatable: true },
    { key: "distance", label: "Distance", type: "number", defaultValue: 8, min: 0, max: 40, step: 1, animatable: true },
  ],
  tags: ["depth", "shadow", "elevation"],
  backend: { pixiPreview: true, headless: false, ffmpeg: false, deterministic: true },
  cost: "medium",
};

export const glowDescriptor: EffectDescriptor = {
  id: "glow",
  label: "Glow",
  category: "blur",
  description: "Add a luminous glow around the visual object.",
  params: [
    { key: "amount", label: "Intensity", type: "number", defaultValue: 0.4, min: 0, max: 1, step: 0.01, animatable: true },
  ],
  tags: ["blur", "glow", "light"],
  backend: { pixiPreview: true, headless: false, ffmpeg: false, deterministic: true },
  cost: "medium",
};

export const noiseDescriptor: EffectDescriptor = {
  id: "noise",
  label: "Film Grain / Noise",
  category: "stylize",
  description: "Add film grain or noise to the clip.",
  params: [
    { key: "amount", label: "Amount", type: "number", defaultValue: 0.2, min: 0.01, max: 1, step: 0.01, animatable: true },
  ],
  tags: ["stylize", "noise", "grain", "film"],
  backend: { pixiPreview: true, headless: true, ffmpeg: false, deterministic: false, notes: "Seed-based; non-deterministic without fixed seed" },
  cost: "medium",
};

export const posterizeDescriptor: EffectDescriptor = {
  id: "posterize",
  label: "Posterize",
  category: "artistic",
  description: "Reduce the number of color levels for a poster-like effect.",
  params: [
    { key: "levels", label: "Levels", type: "number", defaultValue: 8, min: 2, max: 32, step: 1, animatable: true },
  ],
  tags: ["artistic", "posterize", "stylize"],
  backend: { pixiPreview: true, headless: true, ffmpeg: false, deterministic: true },
  cost: "low",
};

export const pixelateDescriptor: EffectDescriptor = {
  id: "pixelate",
  label: "Pixelate",
  category: "stylize",
  description: "Pixelate the clip into blocks.",
  params: [
    { key: "blockSize", label: "Block Size", type: "number", defaultValue: 8, min: 2, max: 64, step: 1, animatable: true },
  ],
  tags: ["stylize", "pixelate", "mosaic"],
  backend: { pixiPreview: true, headless: false, ffmpeg: false, deterministic: true },
  cost: "medium",
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
];

export function registerBuiltins(): void {
  for (const desc of ALL_DESCRIPTORS) {
    registerEffect(desc);
  }
}
