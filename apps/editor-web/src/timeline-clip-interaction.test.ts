import { describe, expect, it } from 'vitest';
import type { Clip } from '@joy-media/project-schema';
import {
  buildTimelineClipMoveTransaction,
  keyboardTrimTimeUs,
} from './timeline-clip-interaction.js';

const CLIP: Clip = {
  id: 'clip-a',
  kind: 'video',
  assetId: 'asset-a',
  startUs: 1_000_000,
  durationUs: 2_000_000,
  sourceInUs: 0,
};

describe('timeline clip interaction', () => {
  it('builds one semantic atomic transaction for a cross-track move', () => {
    expect(
      buildTimelineClipMoveTransaction({
        compositionId: 'root',
        sourceTrackId: 'V1',
        targetTrackId: 'V2',
        clip: CLIP,
        targetClips: [],
        newStartUs: 4_000_000,
      }),
    ).toEqual({
      label: 'Move clip-a to V2',
      commands: [
        {
          type: 'timeline.moveElement',
          payload: {
            compositionId: 'root',
            sourceTrackId: 'V1',
            targetTrackId: 'V2',
            clipId: 'clip-a',
            newStartUs: 4_000_000,
          },
        },
      ],
    });
  });

  it('rejects an overlapping destination before dispatch', () => {
    expect(
      buildTimelineClipMoveTransaction({
        compositionId: 'root',
        sourceTrackId: 'V1',
        targetTrackId: 'V2',
        clip: CLIP,
        targetClips: [{ ...CLIP, id: 'occupied', startUs: 2_000_000 }],
        newStartUs: 3_000_000,
      }),
    ).toBeUndefined();
  });

  it('nudges either trim edge and clamps it to a valid range', () => {
    expect(
      keyboardTrimTimeUs({
        clip: CLIP,
        edge: 'start',
        key: 'ArrowRight',
        timelineDurationUs: 10_000_000,
      }),
    ).toBe(1_100_000);
    expect(
      keyboardTrimTimeUs({
        clip: CLIP,
        edge: 'end',
        key: 'ArrowLeft',
        shiftKey: true,
        timelineDurationUs: 10_000_000,
      }),
    ).toBe(2_000_000);
    expect(
      keyboardTrimTimeUs({
        clip: { ...CLIP, startUs: 0 },
        edge: 'start',
        key: 'ArrowLeft',
        timelineDurationUs: 10_000_000,
      }),
    ).toBe(0);
    expect(
      keyboardTrimTimeUs({
        clip: CLIP,
        edge: 'end',
        key: 'Enter',
        timelineDurationUs: 10_000_000,
      }),
    ).toBeUndefined();
  });
});
