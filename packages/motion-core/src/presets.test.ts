import { describe, expect, it } from 'vitest';
import type { VisualObjectTransformV1 } from '@joy-media/project-schema';
import { BUILTIN_MOTIONS } from './builtins.js';
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

  it('ships one built-in Library descriptor per preset, in the same order', () => {
    // The Library grid renders BUILTIN_MOTIONS while the Presets tab applies
    // JOY_MOTION_PRESETS — a card with no builder is a dead tile, and a builder
    // with no card is unreachable from the panel.
    expect(BUILTIN_MOTIONS.map((motion) => motion.id)).toEqual(
      JOY_MOTION_PRESETS.map((preset) => preset.id),
    );
    for (const motion of BUILTIN_MOTIONS) {
      expect(motion.durationMs).toBeGreaterThan(0);
      expect(resolveMotionPreset(motion.id)?.name).toBe(motion.name);
    }
  });

  it('builds every preset onto its declared channels, around the base transform', () => {
    for (const preset of JOY_MOTION_PRESETS) {
      const channels = preset.build(options);
      expect(Object.keys(channels).sort()).toEqual([...preset.channels].sort());
      for (const curve of Object.values(channels)) {
        expect(curve!.keyframes.length).toBeGreaterThanOrEqual(2);
        const times = curve!.keyframes.map((keyframe) => keyframe.timeUs);
        expect(times).toEqual([...times].sort((a, b) => a - b));
        expect(times[0]).toBe(0);
        expect(times.at(-1)).toBeLessThanOrEqual(1_000_000);
      }
    }
  });

  it('slide-in-left enters from off-frame left and lands on the base x', () => {
    const channels = buildPresetChannels('joy-slide-in-left', options);
    expect(sampleCurve(channels.x!, 0)).toBe(base.x - 280);
    expect(sampleCurve(channels.x!, 1_000_000)).toBe(base.x);
    expect(sampleCurve(channels.opacity!, 0)).toBe(0);
  });

  it('slide-out-right ends off-frame and fully transparent', () => {
    const channels = buildPresetChannels('joy-slide-out-right', options);
    expect(sampleCurve(channels.x!, 0)).toBe(base.x);
    expect(sampleCurve(channels.x!, 1_000_000)).toBe(base.x + 280);
    expect(sampleCurve(channels.opacity!, 1_000_000)).toBe(0);
  });

  it('bounce-in hops above the base line and settles on it', () => {
    const channels = buildPresetChannels('joy-bounce-in', options);
    expect(sampleCurve(channels.y!, 0)).toBe(base.y - 340);
    expect(sampleCurve(channels.y!, 550_000)).toBeLessThan(base.y); // mid-air hop
    expect(sampleCurve(channels.y!, 1_000_000)).toBe(base.y);
  });

  it('bounce-drop squashes on impact and recovers to the base scale', () => {
    const channels = buildPresetChannels('joy-bounce-drop', options);
    expect(sampleCurve(channels.scaleY!, 450_000)).toBeLessThan(base.scaleY);
    expect(sampleCurve(channels.scaleX!, 450_000)).toBeGreaterThan(base.scaleX);
    expect(sampleCurve(channels.scaleY!, 1_000_000)).toBe(base.scaleY);
    expect(sampleCurve(channels.scaleX!, 1_000_000)).toBe(base.scaleX);
  });

  it('flip-in-y opens from edge-on to the base width', () => {
    const channels = buildPresetChannels('joy-flip-in-y', options);
    expect(sampleCurve(channels.scaleX!, 0)).toBeCloseTo(0.02, 6);
    expect(sampleCurve(channels.scaleX!, 720_000)).toBeGreaterThan(base.scaleX);
    expect(sampleCurve(channels.scaleX!, 1_000_000)).toBe(base.scaleX);
  });

  it('depth-push-in approaches z=0 from behind and treats absent positionZ as 0', () => {
    const channels = buildPresetChannels('joy-depth-push-in', options);
    expect(base.positionZ).toBeUndefined();
    expect(sampleCurve(channels.positionZ!, 0)).toBe(900);
    expect(sampleCurve(channels.positionZ!, 1_000_000)).toBe(0);
  });

  it('depth presets offset from an authored positionZ rather than absolute 0', () => {
    const lifted = { ...base, positionZ: -150 };
    const channels = buildPresetChannels('joy-depth-pull-out', { ...options, base: lifted });
    expect(sampleCurve(channels.positionZ!, 0)).toBe(-150);
    expect(sampleCurve(channels.positionZ!, 1_000_000)).toBe(950);
  });

  it('respects the start offset and rejects a non-positive duration', () => {
    const shifted = buildPresetChannels('joy-fade-in', { ...options, startUs: 500_000 });
    expect(shifted.opacity!.keyframes[0]!.timeUs).toBe(500_000);
    expect(() => buildPresetChannels('joy-fade-in', { ...options, durationUs: 0 })).toThrow();
    expect(() => buildPresetChannels('ghost', options)).toThrow();
  });
});
