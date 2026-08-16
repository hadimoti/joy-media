import { describe, expect, it } from 'vitest';
import type { Track } from '@joy-media/project-schema';
import {
  canPlaceTimelineElement,
  buildTimelineTrackReorderTransaction,
  nextProfessionalTrackId,
  professionalTrackCode,
  sortTracksForTimelineDisplay,
  timelineTrackFamily,
} from './timeline-track-family.js';

const track = (id: string, order: number, family?: 'visual' | 'audio'): Track => ({
  id,
  kind: 'video',
  ...(family === undefined ? {} : { family }),
  order,
  enabled: true,
  clips: [],
});

describe('professional timeline track families', () => {
  it('keeps visual tracks above audio and maps top visual rows to highest order', () => {
    expect(
      sortTracksForTimelineDisplay([
        track('A1', 4, 'audio'),
        track('V1', 1, 'visual'),
        track('V2', 3, 'visual'),
      ]).map((item) => item.id),
    ).toEqual(['V2', 'V1', 'A1']);
  });

  it('permits every visual element on a visual layer and only audio on audio', () => {
    const visual = track('V1', 0, 'visual');
    const audio = track('A1', 1, 'audio');
    expect(canPlaceTimelineElement('text', visual)).toBe(true);
    expect(canPlaceTimelineElement('audio', visual)).toBe(false);
    expect(canPlaceTimelineElement('audio', audio)).toBe(true);
    expect(canPlaceTimelineElement('scene3d', audio)).toBe(false);
  });

  it('recognises legacy all-audio rows without using their human name', () => {
    const legacy = {
      ...track('legacy', 0),
      clips: [
        {
          id: 'voice-1',
          kind: 'video' as const,
          assetId: 'asset.wav',
          startUs: 0,
          durationUs: 1,
          sourceInUs: 0,
        },
      ],
    };
    expect(timelineTrackFamily(legacy)).toBe('audio');
    expect(professionalTrackCode('visual', 2)).toBe('V2');
    expect(professionalTrackCode('audio', 2)).toBe('A2');
  });

  it('does not reuse a durable family ID after a row was deleted', () => {
    expect(nextProfessionalTrackId([track('V2', 0, 'visual')], 'visual')).toBe('V3');
    expect(nextProfessionalTrackId([track('A1', 0, 'audio')], 'audio')).toBe('A2');
  });

  it('reorders an entire visual stack atomically without crossing into audio', () => {
    const tracks = [
      track('V-bottom', 0, 'visual'),
      track('V-top', 1, 'visual'),
      track('A1', 2, 'audio'),
    ];
    expect(
      buildTimelineTrackReorderTransaction({
        compositionId: 'root',
        tracks,
        sourceTrackId: 'V-bottom',
        targetTrackId: 'V-top',
      }),
    ).toMatchObject({
      label: 'Reorder visual layers',
      commands: [
        {
          type: 'timeline.reorderTracks',
          payload: {
            orders: [
              { trackId: 'V-bottom', newOrder: 2 },
              { trackId: 'V-top', newOrder: 1 },
              { trackId: 'A1', newOrder: 0 },
            ],
          },
        },
      ],
    });
    expect(
      buildTimelineTrackReorderTransaction({
        compositionId: 'root',
        tracks,
        sourceTrackId: 'V-bottom',
        targetTrackId: 'A1',
      }),
    ).toBeUndefined();
  });
});
