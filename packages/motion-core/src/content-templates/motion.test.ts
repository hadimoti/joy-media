import { describe, expect, it } from 'vitest';
import { sampleTitleMotion } from './motion.js';
import type { TitleMotion } from '@joy-media/project-schema';

const duration = 2_000_000;
const motion = (presetId: TitleMotion['presetId']): TitleMotion => ({
  presetId,
  inUs: 500_000,
  outUs: 500_000,
});

describe('sampleTitleMotion', () => {
  for (const preset of ['joy-fade-in', 'joy-slide-up', 'hold'] as const) {
    it(`samples ${preset} at entrance, hold, exit and clamped endpoints`, () => {
      const m = motion(preset);
      const start = sampleTitleMotion(m, duration, 0);
      const entranceEnd = sampleTitleMotion(m, duration, 500_000);
      const middle = sampleTitleMotion(m, duration, 1_000_000);
      const fadeEnd = sampleTitleMotion(m, duration, duration);
      expect(start.opacity).toBe(preset === 'hold' ? 1 : 0);
      expect(entranceEnd.opacity).toBe(1);
      expect(middle.opacity).toBe(1);
      expect(fadeEnd.opacity).toBe(0);
      expect(sampleTitleMotion(m, duration, -5).opacity).toBe(start.opacity);
      expect(sampleTitleMotion(m, duration, duration + 10).opacity).toBe(fadeEnd.opacity);
    });
  }
  it('moves slide-up from 80px down to its resting position during entrance', () => {
    const m = motion('joy-slide-up');
    expect(sampleTitleMotion(m, duration, 0).translateYPx).toBe(80);
    expect(sampleTitleMotion(m, duration, 500_000).translateYPx).toBe(0);
  });
  it('keeps hold fully opaque through the middle', () => {
    expect(sampleTitleMotion(motion('hold'), duration, 1_000_000)).toEqual({
      opacity: 1,
      translateYPx: 0,
    });
  });
});
