import { describe, expect, it } from 'vitest';
import { resolvePropertyAnimationTime } from './property-time-domain.js';

describe('resolvePropertyAnimationTime', () => {
  it('keeps composition/output/audio times in their explicit global domains', () => {
    const context = {
      compositionTimeUs: 4_000_000,
      outputTimeUs: 9_000_000,
      audioTimelineTimeUs: 7_000_000,
    };

    expect(resolvePropertyAnimationTime('composition', context)).toEqual({
      domain: 'composition',
      timeUs: 4_000_000,
      clamped: false,
    });
    expect(resolvePropertyAnimationTime('output', context)).toEqual({
      domain: 'output',
      timeUs: 9_000_000,
      clamped: false,
    });
    expect(resolvePropertyAnimationTime('audio-timeline', context)).toEqual({
      domain: 'audio-timeline',
      timeUs: 7_000_000,
      clamped: false,
    });
  });

  it('rebases clip-local time and clamps it at clip boundaries', () => {
    const context = {
      compositionTimeUs: 13_000_000,
      clip: { startUs: 10_000_000, durationUs: 5_000_000 },
    };

    expect(resolvePropertyAnimationTime('clip-local', context)).toEqual({
      domain: 'clip-local',
      timeUs: 3_000_000,
      clamped: false,
    });
    expect(
      resolvePropertyAnimationTime('clip-local', {
        ...context,
        compositionTimeUs: 7_000_000,
      }),
    ).toEqual({ domain: 'clip-local', timeUs: 0, clamped: true });
    expect(
      resolvePropertyAnimationTime('clip-local', {
        ...context,
        compositionTimeUs: 20_000_000,
      }),
    ).toEqual({ domain: 'clip-local', timeUs: 5_000_000, clamped: true });
  });

  it.each([
    ['transition-local', 'transition'],
    ['caption-clip-local', 'captionClip'],
    ['scene-local', 'scene'],
  ] as const)('rebases %s against its matching local range', (domain, key) => {
    const result = resolvePropertyAnimationTime(domain, {
      compositionTimeUs: 2_500_000,
      [key]: { startUs: 2_000_000, durationUs: 1_000_000 },
    });

    expect(result).toEqual({ domain, timeUs: 500_000, clamped: false });
  });

  it('requires an explicit local range instead of redirecting an edit', () => {
    expect(() =>
      resolvePropertyAnimationTime('clip-local', {
        compositionTimeUs: 1_000_000,
      }),
    ).toThrow('clip-local requires a clip time range');
  });
});
