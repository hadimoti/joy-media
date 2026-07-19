/**
 * Motion presets (§20.3): named, reusable animations that build keyframe curves
 * relative to an object's static transform over a chosen window. Presets are
 * pure builders — applying one means dispatching the resulting curves through
 * the normal `object.replaceAnimation` command, so presets inherit undo/redo and
 * persistence for free. These are original JOY presets.
 */

import type {
  AnimatablePropertyV1,
  AnimationCurveV1,
  TimeUs,
  VisualObjectTransformV1,
} from '@joy-media/project-schema';

export interface MotionPresetOptions {
  /** Window start in object-local microseconds. */
  readonly startUs: TimeUs;
  /** Window length in microseconds; must be > 0. */
  readonly durationUs: number;
  /** The object's static transform — presets animate around these base values. */
  readonly base: VisualObjectTransformV1;
}

export type PresetChannels = Partial<Record<AnimatablePropertyV1, AnimationCurveV1>>;

export interface MotionPreset {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly channels: readonly AnimatablePropertyV1[];
  build(options: MotionPresetOptions): PresetChannels;
}

function assertWindow(options: MotionPresetOptions): { start: TimeUs; end: TimeUs } {
  if (!(options.durationUs > 0)) throw new RangeError('preset duration must be positive');
  const start = Math.round(options.startUs);
  return { start, end: start + Math.round(options.durationUs) };
}

/** Fade in from transparent to the object's base opacity. */
const fadeIn: MotionPreset = {
  id: 'joy-fade-in',
  name: 'Fade In',
  description: 'Opacity rises from 0 to the object value.',
  channels: ['opacity'],
  build(options) {
    const { start, end } = assertWindow(options);
    return {
      opacity: {
        keyframes: [
          { timeUs: start, value: 0, interpolation: 'eased' },
          { timeUs: end, value: options.base.opacity, interpolation: 'linear' },
        ],
      },
    };
  },
};

/** Fade out from the base opacity to transparent. */
const fadeOut: MotionPreset = {
  id: 'joy-fade-out',
  name: 'Fade Out',
  description: 'Opacity falls from the object value to 0.',
  channels: ['opacity'],
  build(options) {
    const { start, end } = assertWindow(options);
    return {
      opacity: {
        keyframes: [
          { timeUs: start, value: options.base.opacity, interpolation: 'eased' },
          { timeUs: end, value: 0, interpolation: 'linear' },
        ],
      },
    };
  },
};

/** Scale-and-fade entrance with a subtle overshoot at 70% of the window. */
const popIn: MotionPreset = {
  id: 'joy-pop-in',
  name: 'Pop In',
  description: 'Scales up past 100% then settles, fading in.',
  channels: ['scaleX', 'scaleY', 'opacity'],
  build(options) {
    const { start, end } = assertWindow(options);
    const overshootAt = start + Math.round((end - start) * 0.7);
    const scaleCurve = (target: number): AnimationCurveV1 => ({
      keyframes: [
        { timeUs: start, value: target * 0.6, interpolation: 'eased' },
        { timeUs: overshootAt, value: target * 1.08, interpolation: 'eased' },
        { timeUs: end, value: target, interpolation: 'linear' },
      ],
    });
    return {
      scaleX: scaleCurve(options.base.scaleX),
      scaleY: scaleCurve(options.base.scaleY),
      opacity: {
        keyframes: [
          { timeUs: start, value: 0, interpolation: 'eased' },
          { timeUs: overshootAt, value: options.base.opacity, interpolation: 'linear' },
        ],
      },
    };
  },
};

/** Slide up into place from 80px below, fading in. */
const slideUp: MotionPreset = {
  id: 'joy-slide-up',
  name: 'Slide Up',
  description: 'Rises into place from below while fading in.',
  channels: ['y', 'opacity'],
  build(options) {
    const { start, end } = assertWindow(options);
    return {
      y: {
        keyframes: [
          { timeUs: start, value: options.base.y + 80, interpolation: 'eased' },
          { timeUs: end, value: options.base.y, interpolation: 'linear' },
        ],
      },
      opacity: {
        keyframes: [
          { timeUs: start, value: 0, interpolation: 'eased' },
          { timeUs: end, value: options.base.opacity, interpolation: 'linear' },
        ],
      },
    };
  },
};

export const JOY_MOTION_PRESETS: readonly MotionPreset[] = [fadeIn, fadeOut, popIn, slideUp];

/** Looks up a preset by id, or `undefined` when unknown. */
export function resolveMotionPreset(id: string): MotionPreset | undefined {
  return JOY_MOTION_PRESETS.find((preset) => preset.id === id);
}

/** Builds a preset's channel curves, throwing on an unknown id. */
export function buildPresetChannels(id: string, options: MotionPresetOptions): PresetChannels {
  const preset = resolveMotionPreset(id);
  if (preset === undefined) throw new RangeError(`unknown motion preset "${id}"`);
  return preset.build(options);
}
