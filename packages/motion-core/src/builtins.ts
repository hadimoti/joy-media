/**
 * Pre-registered built-in motions: one descriptor per entry in
 * `JOY_MOTION_PRESETS`, so the Library grid and the Presets dropdown always
 * offer the same set. `presets.test.ts` holds that parity to the ids.
 *
 * Only the original four have poster art; every card previews the motion live
 * on the shared logo PNG (see `animationForMotion` in `MotionPanel.tsx`).
 */

import { convertPresetToScene } from './registry.js';
import type { MotionRegistry } from './registry.js';
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
  builtinMotion(
    'joy-fade-in',
    'Fade In',
    'fade',
    'Opacity rises from 0 to the object value.',
    1000,
    undefined,
    { posterUrl: '/assets/motion-previews/joy-fade-in.png' },
  ),
  builtinMotion(
    'joy-fade-out',
    'Fade Out',
    'fade',
    'Opacity falls from the object value to 0.',
    1000,
    undefined,
    { posterUrl: '/assets/motion-previews/joy-fade-out.png' },
  ),
  builtinMotion(
    'joy-pop-in',
    'Pop In',
    'scale',
    'Scales up past 100% then settles, fading in.',
    1200,
    undefined,
    { posterUrl: '/assets/motion-previews/joy-pop-in.png' },
  ),
  builtinMotion(
    'joy-pop-out',
    'Pop Out',
    'scale',
    'Swells past 100% then collapses away, fading out.',
    1000,
  ),
  builtinMotion(
    'joy-zoom-in',
    'Zoom In',
    'scale',
    'Grows from 20% to full size while fading in.',
    1000,
  ),
  builtinMotion('joy-zoom-out', 'Zoom Out', 'scale', 'Shrinks to 20% and fades away.', 1000),
  builtinMotion(
    'joy-punch-in',
    'Punch In',
    'scale',
    'Slams down from 220% to full size — no overshoot.',
    700,
  ),
  builtinMotion(
    'joy-slide-up',
    'Slide Up',
    'slide',
    'Rises into place from below while fading in.',
    1200,
    undefined,
    { posterUrl: '/assets/motion-previews/joy-slide-up.png' },
  ),
  builtinMotion(
    'joy-slide-down',
    'Slide Down',
    'slide',
    'Drops into place from above while fading in.',
    1200,
  ),
  builtinMotion(
    'joy-slide-in-left',
    'Slide In Left',
    'slide',
    'Enters from off-frame left while fading in.',
    1100,
  ),
  builtinMotion(
    'joy-slide-in-right',
    'Slide In Right',
    'slide',
    'Enters from off-frame right while fading in.',
    1100,
  ),
  builtinMotion(
    'joy-slide-out-up',
    'Slide Out Up',
    'slide',
    'Leaves upward while fading out.',
    1000,
  ),
  builtinMotion(
    'joy-slide-out-left',
    'Slide Out Left',
    'slide',
    'Leaves toward frame left while fading out.',
    1000,
  ),
  builtinMotion(
    'joy-slide-out-right',
    'Slide Out Right',
    'slide',
    'Leaves toward frame right while fading out.',
    1000,
  ),
  builtinMotion(
    'joy-bounce-in',
    'Bounce In',
    'bounce',
    'Falls in and settles through four decaying hops.',
    1600,
  ),
  builtinMotion(
    'joy-bounce-out',
    'Bounce Out',
    'bounce',
    'Hops twice, then drops out of frame.',
    1400,
  ),
  builtinMotion(
    'joy-bounce-drop',
    'Bounce Drop',
    'bounce',
    'Drops from above and squashes on impact before settling.',
    1600,
  ),
  builtinMotion(
    'joy-rubber-band',
    'Rubber Band',
    'bounce',
    'Stretches and squashes in place, then settles.',
    1200,
  ),
  builtinMotion(
    'joy-spin-in',
    'Spin In',
    'custom',
    'Turns a half circle into place while growing and fading in.',
    1200,
  ),
  builtinMotion(
    'joy-spin-out',
    'Spin Out',
    'custom',
    'Turns a half circle away while shrinking and fading out.',
    1100,
  ),
  builtinMotion(
    'joy-swing-in',
    'Swing In',
    'custom',
    'Swings in on a decaying tilt, like a hinged sign.',
    1400,
  ),
  builtinMotion(
    'joy-roll-in',
    'Roll In',
    'custom',
    'Rolls in from frame left, turning as it travels.',
    1300,
  ),
  builtinMotion(
    'joy-roll-out',
    'Roll Out',
    'custom',
    'Rolls off toward frame right, turning as it travels.',
    1300,
  ),
  builtinMotion(
    'joy-arc-in',
    'Arc In',
    'custom',
    'Travels in along a lifted arc and levels out.',
    1400,
  ),
  builtinMotion(
    'joy-flip-in-x',
    'Flip In X',
    'scale',
    'Opens out around the horizontal axis, like a turning card.',
    1100,
  ),
  builtinMotion(
    'joy-flip-in-y',
    'Flip In Y',
    'scale',
    'Opens out around the vertical axis, like a turning card.',
    1100,
  ),
  builtinMotion(
    'joy-flip-out-y',
    'Flip Out Y',
    'scale',
    'Closes edge-on around the vertical axis and fades out.',
    1000,
  ),
  builtinMotion(
    'joy-depth-push-in',
    'Depth Push In',
    'scale',
    'Comes forward from deep in the scene (needs an active camera).',
    1300,
  ),
  builtinMotion(
    'joy-depth-pull-out',
    'Depth Pull Out',
    'scale',
    'Recedes into the background and fades (needs an active camera).',
    1300,
  ),
  builtinMotion(
    'joy-fly-through-out',
    'Fly Through',
    'scale',
    'Rushes past the lens — depth toward camera plus a scale blowout.',
    1200,
  ),
];

export function registerBuiltinMotions(registry: MotionRegistry): void {
  for (const motion of BUILTIN_MOTIONS) {
    registry.register(motion);
  }
}

export { BUILTIN_MOTIONS };
