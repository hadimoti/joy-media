import type { TitleMotion } from '@joy-media/project-schema';
import { cubicBezierEase } from '../interpolation.js';
import { P0_PAINT_POLICY } from './catalog.js';

export interface SampledTitleMotion {
  readonly opacity: number;
  readonly translateYPx: number;
}

/** Samples title-local motion. Entrance and exit use the preset eased-keyframe curve. */
export function sampleTitleMotion(
  motion: TitleMotion,
  durationUs: number,
  clipLocalUs: number,
): SampledTitleMotion {
  const duration = Math.max(0, durationUs);
  const time = Math.min(duration, Math.max(0, clipLocalUs));
  const incoming =
    motion.presetId === 'hold' || motion.inUs <= 0
      ? 1
      : cubicBezierEase(P0_PAINT_POLICY.easedHandles, Math.min(1, time / motion.inUs));
  const exitStart = duration - motion.outUs;
  const outgoing =
    motion.outUs <= 0 || time <= exitStart
      ? 1
      : 1 -
        cubicBezierEase(
          P0_PAINT_POLICY.easedHandles,
          Math.min(1, (time - exitStart) / motion.outUs),
        );
  const opacity = Math.max(0, Math.min(1, incoming * outgoing));
  const translateYPx =
    motion.presetId === 'joy-slide-up' ? P0_PAINT_POLICY.slideExcursionPx * (1 - incoming) : 0;
  return { opacity, translateYPx };
}
