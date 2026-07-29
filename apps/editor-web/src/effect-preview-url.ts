const EFFECT_PREVIEW_REVISION = 'pixel-bw-v1';
const EFFECT_MOTION_PREVIEW_REVISION = 'joy-motion-v1';
const EFFECT_MOTION_PREVIEW_COUNT = 19;

// The first nineteen catalog entries intentionally cover every supplied JOY loop.
const EFFECT_MOTION_ORDER = [
  'brightness-contrast',
  'hue-saturation',
  'vibrance',
  'vignette',
  'sepia',
  'gaussian-blur',
  'bloom',
  'drop-shadow',
  'glow',
  'noise',
  'posterize',
  'pixelate',
  'color-overlay',
  'curves',
  'zoom-blur',
  'radial-blur',
  'tilt-shift',
  'bulge',
  'twist',
] as const;

export function effectPreviewUrl(effectId: string): string {
  return `/effects/preview/${encodeURIComponent(effectId)}.png?v=${EFFECT_PREVIEW_REVISION}`;
}

export function effectMotionPreviewUrl(effectId: string): string {
  const knownIndex = EFFECT_MOTION_ORDER.indexOf(effectId as (typeof EFFECT_MOTION_ORDER)[number]);
  const index = knownIndex >= 0 ? knownIndex : stableIndex(effectId);
  const file = String((index % EFFECT_MOTION_PREVIEW_COUNT) + 1).padStart(2, '0');
  return `/effects/preview-motion/joy-motion-${file}.webm?v=${EFFECT_MOTION_PREVIEW_REVISION}`;
}

function stableIndex(value: string): number {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
