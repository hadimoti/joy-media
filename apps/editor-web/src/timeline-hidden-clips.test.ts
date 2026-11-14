import type { Composition } from '@joy-media/project-schema';
import { describe, expect, it } from 'vitest';
import { hiddenClipIds } from './timeline-hidden-clips.js';

describe('hiddenClipIds (the eye button on a track)', () => {
  it('collects the clips of the hidden tracks only', () => {
    const composition = {
      id: 'root',
      tracks: [
        { id: 'V1', enabled: true, clips: [{ id: 'a' }] },
        { id: 'V2', enabled: false, clips: [{ id: 'text-1' }, { id: 'text-2' }] },
        { id: 'V3', clips: [{ id: 'b' }] },
      ],
    } as unknown as Composition;
    expect([...hiddenClipIds({ compositions: { root: composition } })].sort()).toEqual([
      'text-1',
      'text-2',
    ]);
  });
});
