/**
 * Basic motion blur (§20.3): the shutter interval and its sample times. A frame
 * is sampled at several sub-frame instants across an open shutter and averaged
 * by the renderer; this module owns only the deterministic sample-time math. The
 * shutter angle (0–360°) sets how much of the frame the shutter is open;
 * `samples` is the quality knob.
 */

import type { MotionBlurV1 } from '@joy-media/project-schema';

/**
 * Sub-frame sample offsets (microseconds from the frame start) for a frame of
 * `frameDurationUs`. The shutter interval is centered in the frame and spans
 * `shutterAngleDeg / 360` of it. A disabled blur (or one sample) yields a single
 * sample at the frame center — the crisp, no-blur case.
 */
export function motionBlurSampleOffsetsUs(
  frameDurationUs: number,
  config: MotionBlurV1 | undefined,
): readonly number[] {
  const center = frameDurationUs / 2;
  if (config === undefined || !config.enabled || config.samples <= 1) return [center];
  const shutter = (frameDurationUs * Math.min(360, Math.max(0, config.shutterAngleDeg))) / 360;
  if (shutter <= 0) return [center];
  const first = center - shutter / 2;
  const step = shutter / (config.samples - 1);
  const offsets: number[] = [];
  for (let i = 0; i < config.samples; i += 1) offsets.push(first + i * step);
  return offsets;
}
