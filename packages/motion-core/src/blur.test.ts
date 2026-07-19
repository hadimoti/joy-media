import { describe, expect, it } from 'vitest';
import type { MotionBlurV1 } from '@joy-media/project-schema';
import { motionBlurSampleOffsetsUs } from './blur.js';

const frameUs = 33_367; // ~1 frame at 29.97 fps

describe('motionBlurSampleOffsetsUs', () => {
  it('returns a single centered sample when disabled', () => {
    expect(motionBlurSampleOffsetsUs(frameUs, undefined)).toEqual([frameUs / 2]);
    const off: MotionBlurV1 = { enabled: false, shutterAngleDeg: 180, samples: 8 };
    expect(motionBlurSampleOffsetsUs(frameUs, off)).toEqual([frameUs / 2]);
  });

  it('spreads samples across a shutter interval centered in the frame', () => {
    const config: MotionBlurV1 = { enabled: true, shutterAngleDeg: 180, samples: 3 };
    const offsets = motionBlurSampleOffsetsUs(frameUs, config);
    expect(offsets).toHaveLength(3);
    // 180 degrees -> half the frame, centered: [frame*0.25, frame*0.5, frame*0.75]
    expect(offsets[0]).toBeCloseTo(frameUs * 0.25, 3);
    expect(offsets[1]).toBeCloseTo(frameUs * 0.5, 3);
    expect(offsets[2]).toBeCloseTo(frameUs * 0.75, 3);
  });

  it('widens the interval with a larger shutter angle', () => {
    const config: MotionBlurV1 = { enabled: true, shutterAngleDeg: 360, samples: 2 };
    const offsets = motionBlurSampleOffsetsUs(frameUs, config);
    expect(offsets[0]).toBeCloseTo(0, 3);
    expect(offsets[offsets.length - 1]!).toBeCloseTo(frameUs, 3);
  });

  it('falls back to a single sample for one sample or a zero shutter', () => {
    expect(
      motionBlurSampleOffsetsUs(frameUs, { enabled: true, shutterAngleDeg: 180, samples: 1 }),
    ).toEqual([frameUs / 2]);
    expect(
      motionBlurSampleOffsetsUs(frameUs, { enabled: true, shutterAngleDeg: 0, samples: 8 }),
    ).toEqual([frameUs / 2]);
  });
});
