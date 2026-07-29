import { describe, expect, it } from 'vitest';
import { rational, type SpikeProject } from '@joy-media/project-schema';
import { isSingleVideoClipSelected } from './effects-apply-state.js';

const timeline: SpikeProject = {
  schemaVersion: 0,
  id: 'preview-test',
  rootCompositionId: 'root',
  compositions: {
    root: {
      id: 'root',
      name: 'Root',
      width: 1920,
      height: 1080,
      frameRate: rational(30, 1),
      durationUs: 1_000_000,
      tracks: [
        {
          id: 'video',
          kind: 'video',
          order: 0,
          enabled: true,
          clips: [
            {
              id: 'video-clip',
              kind: 'video',
              assetId: 'video',
              startUs: 0,
              durationUs: 1_000_000,
              sourceInUs: 0,
            },
            {
              id: 'nested-composition',
              kind: 'composition',
              compositionId: 'child',
              startUs: 0,
              durationUs: 1_000_000,
              childOffsetUs: 0,
            },
          ],
        },
      ],
    },
  },
};

describe('isSingleVideoClipSelected', () => {
  it('allows exactly one selected video clip', () => {
    expect(isSingleVideoClipSelected(timeline, ['video-clip'])).toBe(true);
  });

  it('rejects an empty, mixed, or non-video selection', () => {
    expect(isSingleVideoClipSelected(timeline, [])).toBe(false);
    expect(isSingleVideoClipSelected(timeline, ['nested-composition'])).toBe(false);
    expect(isSingleVideoClipSelected(timeline, ['video-clip', 'nested-composition'])).toBe(false);
  });
});
