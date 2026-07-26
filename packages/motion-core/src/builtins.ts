/**
 * Pre-registered built-in motions converted from the original 4 presets.
 */

import { MotionRegistry, convertPresetToScene } from './registry.js';
import type { MotionDescriptor, AspectSupport, MotionPreviewDescriptor } from './descriptor.js';

function builtinMotion(
  id: string,
  name: string,
  category: MotionDescriptor['category'],
  description: string,
  durationMs = 1000,
  aspectSupport: readonly AspectSupport[] = ['9:16', '16:9', '1:1'],
  preview?: MotionPreviewDescriptor,
): MotionDescriptor {
  return {
    id,
    name,
    description,
    source: 'built-in',
    version: 1,
    schemaVersion: 1,
    category,
    tags: [category, name.toLowerCase().replace(/\s+/g, '-')],
    durationMs,
    loop: false,
    aspectSupport,
    scene: convertPresetToScene(name, 1080, 1920, durationMs),
    capabilities: [],
    ...(preview !== undefined ? { preview } : {}),
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

const BUILTIN_MOTIONS: readonly MotionDescriptor[] = [
  builtinMotion('joy-fade-in', 'Fade In', 'fade', 'Opacity rises from 0 to the object value.', 1000, undefined, { posterUrl: '/assets/motion-previews/joy-fade-in.png' }),
  builtinMotion('joy-fade-out', 'Fade Out', 'fade', 'Opacity falls from the object value to 0.', 1000, undefined, { posterUrl: '/assets/motion-previews/joy-fade-out.png' }),
  builtinMotion('joy-pop-in', 'Pop In', 'scale', 'Scales up past 100% then settles, fading in.', 1200, undefined, { posterUrl: '/assets/motion-previews/joy-pop-in.png' }),
  builtinMotion('joy-slide-up', 'Slide Up', 'slide', 'Rises into place from below while fading in.', 1200, undefined, { posterUrl: '/assets/motion-previews/joy-slide-up.png' }),
];

export function registerBuiltinMotions(registry: MotionRegistry): void {
  for (const motion of BUILTIN_MOTIONS) {
    registry.register(motion);
  }
}

export { BUILTIN_MOTIONS };
