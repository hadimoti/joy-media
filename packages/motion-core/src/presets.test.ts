import { describe, expect, it } from 'vitest';
import type { VisualObjectTransformV1 } from '@joy-media/project-schema';
import { sampleCurve } from './curve.js';
import { buildPresetChannels, JOY_MOTION_PRESETS, resolveMotionPreset } from './presets.js';

const base: VisualObjectTransformV1 = {
  x: 20,
  y: 200,
  scaleX: 1,
  scaleY: 1,
  rotationDeg: 0,
  opacity: 1,
  crop: { left: 0, top: 0, right: 0, bottom: 0 },
};

const options = { startUs: 0, durationUs: 1_000_000, base };

describe('JOY motion presets', () => {
  it('exposes at least three original presets by stable id', () => {
    expect(JOY_MOTION_PRESETS.length).toBeGreaterThanOrEqual(3);
    expect(resolveMotionPreset('joy-fade-in')?.name).toBe('Fade In');
    expect(resolveMotionPreset('nope')).toBeUndefined();
  });

  it('fade-in animates opacity 0 -> base over the window', () => {
    const channels = buildPresetChannels('joy-fade-in', options);
    const opacity = channels.opacity!;
    expect(sampleCurve(opacity, 0)).toBe(0);
    expect(sampleCurve(opacity, 1_000_000)).toBe(1);
  });

  it('pop-in overshoots scale above the base before settling', () => {
    const channels = buildPresetChannels('joy-pop-in', options);
    const scaleX = channels.scaleX!;
    expect(sampleCurve(scaleX, 0)).toBeCloseTo(0.6, 6);
    expect(sampleCurve(scaleX, 700_000)).toBeGreaterThan(1); // overshoot
    expect(sampleCurve(scaleX, 1_000_000)).toBe(1); // settles at base
  });

  it('slide-up starts below the base position and lands on it', () => {
    const channels = buildPresetChannels('joy-slide-up', options);
    const y = channels.y!;
    expect(sampleCurve(y, 0)).toBe(280); // base.y + 80
    expect(sampleCurve(y, 1_000_000)).toBe(200);
  });

  it('respects the start offset and rejects a non-positive duration', () => {
    const shifted = buildPresetChannels('joy-fade-in', { ...options, startUs: 500_000 });
    expect(shifted.opacity!.keyframes[0]!.timeUs).toBe(500_000);
    expect(() => buildPresetChannels('joy-fade-in', { ...options, durationUs: 0 })).toThrow();
    expect(() => buildPresetChannels('ghost', options)).toThrow();
  });
});
