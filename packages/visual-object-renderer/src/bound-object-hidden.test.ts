import type { JoyProjectV1 } from '@joy-media/project-schema';
import { describe, expect, it } from 'vitest';
import { isBoundObjectActive } from './index.js';

// A text object bound to the clip "text-clip", which plays from 1 s to 3 s.
const project = {
  rootCompositionId: 'root',
  pluginData: { 'joy.clipObjects': { 'text-clip': 'text-object' } },
  compositions: {
    root: {
      id: 'root',
      tracks: [
        {
          id: 'V1',
          clips: [{ id: 'text-clip', startUs: 1_000_000, durationUs: 2_000_000 }],
        },
      ],
    },
  },
} as unknown as JoyProjectV1;

describe('isBoundObjectActive with hidden clips (the eye button on a track)', () => {
  it('draws the object while its clip plays', () => {
    expect(isBoundObjectActive(project, 'text-object', 2_000_000)).toBe(true);
    expect(isBoundObjectActive(project, 'text-object', 4_000_000)).toBe(false);
  });

  it('does not draw an object whose only clip is on a hidden track', () => {
    expect(isBoundObjectActive(project, 'text-object', 2_000_000, new Set(['text-clip']))).toBe(
      false,
    );
  });

  it('keeps an object that has no binding visible', () => {
    expect(isBoundObjectActive(project, 'free-object', 2_000_000, new Set(['text-clip']))).toBe(
      true,
    );
  });
});
