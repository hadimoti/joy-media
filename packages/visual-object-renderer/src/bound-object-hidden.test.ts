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

describe('isBoundObjectActive with a clip only the timeline lists', () => {
  // A picture added from the library: the project's own composition has no clip, the timeline has it.
  const pictureProject = {
    rootCompositionId: 'root',
    pluginData: { 'joy.clipObjects': { 'picture-clip': 'picture-object' } },
    compositions: { root: { id: 'root', tracks: [{ id: 'caption-track', clips: [] }] } },
  } as unknown as JoyProjectV1;
  const timeline = {
    compositions: {
      root: {
        tracks: [{ clips: [{ id: 'picture-clip', startUs: 0, durationUs: 5_000_000 }] }],
      },
    },
  };

  it('is not drawn without the timeline, and is drawn while the timeline clip plays', () => {
    expect(isBoundObjectActive(pictureProject, 'picture-object', 2_000_000)).toBe(false);
    expect(
      isBoundObjectActive(pictureProject, 'picture-object', 2_000_000, new Set(), timeline),
    ).toBe(true);
    expect(
      isBoundObjectActive(pictureProject, 'picture-object', 6_000_000, new Set(), timeline),
    ).toBe(false);
  });

  it('is not drawn when that timeline clip sits on a hidden track', () => {
    expect(
      isBoundObjectActive(
        pictureProject,
        'picture-object',
        2_000_000,
        new Set(['picture-clip']),
        timeline,
      ),
    ).toBe(false);
  });
});
