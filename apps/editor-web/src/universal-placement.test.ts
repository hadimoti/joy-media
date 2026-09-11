import { describe, expect, it } from 'vitest';
import { applyTransaction, type CommandTransaction } from '@joy-media/commands';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import {
  updateUniversalTimelineForTransaction,
  upsertUniversalTimelineBinding,
} from './universal-placement.js';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';

describe('universal placement binding', () => {
  it('copy-on-write preserves legacy items and adds an explicit binding', () => {
    const next = upsertUniversalTimelineBinding(INITIAL_EDITOR_PROJECT, {
      id: 'new-image',
      compositionId: 'root',
      trackId: 'caption-track',
      elementKind: 'image',
      startUs: 4_000_000,
      durationUs: 2_000_000,
      source: { kind: 'object', id: 'product-image' },
    });
    expect(next.universalTimeline?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'caption-clip-1', elementKind: 'caption' }),
        expect.objectContaining({ id: 'new-image', elementKind: 'image', withinTrackOrder: 1 }),
      ]),
    );
    expect(INITIAL_EDITOR_PROJECT.universalTimeline).toBeUndefined();
  });

  it('replacing a binding does not create duplicate item ids', () => {
    const first = upsertUniversalTimelineBinding(INITIAL_EDITOR_PROJECT, {
      id: 'same',
      compositionId: 'root',
      trackId: 'caption-track',
      elementKind: 'text',
      startUs: 0,
      durationUs: 1,
      source: { kind: 'object', id: 'intro-title' },
    });
    const second = upsertUniversalTimelineBinding(first, {
      id: 'same',
      compositionId: 'root',
      trackId: 'caption-track',
      elementKind: 'shape',
      startUs: 1,
      durationUs: 2,
      source: { kind: 'object', id: 'outro-shape' },
    });
    expect(second.universalTimeline?.items.filter((item) => item.id === 'same')).toHaveLength(1);
    expect(second.universalTimeline?.items.find((item) => item.id === 'same')?.elementKind).toBe(
      'shape',
    );
  });

  it('projects clips from an added track and removes them with the track', () => {
    const added = updateUniversalTimelineForTransaction(INITIAL_EDITOR_PROJECT, {
      label: 'Add universal track',
      commands: [
        {
          type: 'timeline.addTrack',
          payload: {
            compositionId: 'root',
            track: {
              id: 'media-track',
              kind: 'video',
              order: 1,
              enabled: true,
              clips: [
                {
                  id: 'added-video',
                  kind: 'video',
                  assetId: 'product-still',
                  startUs: 0,
                  durationUs: 2_000_000,
                  sourceInUs: 0,
                },
                {
                  id: 'added-image',
                  kind: 'video',
                  assetId: 'product-still',
                  startUs: 2_000_000,
                  durationUs: 1_000_000,
                  sourceInUs: 0,
                },
              ],
            },
          },
        },
      ],
    });
    expect(added.universalTimeline?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'added-video',
          trackId: 'media-track',
          elementKind: 'video',
        }),
        expect.objectContaining({
          id: 'added-image',
          trackId: 'media-track',
          withinTrackOrder: 1,
        }),
      ]),
    );

    const removed = updateUniversalTimelineForTransaction(added, {
      label: 'Remove universal track',
      commands: [
        {
          type: 'timeline.removeTrack',
          payload: { compositionId: 'root', trackId: 'media-track' },
        },
      ],
    });
    expect(removed.universalTimeline?.items.some((item) => item.id === 'added-video')).toBe(false);
  });

  it('marks clips inserted on an audio track as audio in the universal timeline', () => {
    const transaction: CommandTransaction = {
      label: 'Add audio',
      commands: [
        {
          type: 'timeline.addTrack',
          payload: {
            compositionId: 'root',
            track: {
              id: 'audio-track',
              kind: 'video',
              family: 'audio',
              order: 1,
              enabled: true,
              clips: [],
            },
          },
        },
        {
          type: 'timeline.insertClip',
          payload: {
            compositionId: 'root',
            trackId: 'audio-track',
            clip: {
              id: 'voice-music-pulse',
              kind: 'video',
              assetId: 'music-pulse.wav',
              startUs: 0,
              durationUs: 3_000_000,
              sourceInUs: 0,
            },
          },
        },
      ],
    };
    const timeline = applyTransaction(buildReferenceSpikeProject(), transaction).project;
    const next = updateUniversalTimelineForTransaction(
      INITIAL_EDITOR_PROJECT,
      transaction,
      timeline,
    );
    expect(next.universalTimeline?.items).toContainEqual(
      expect.objectContaining({ id: 'voice-music-pulse', elementKind: 'audio' }),
    );
  });

  it('assigns a fresh deterministic within-track order on cross-track moves', () => {
    const added = updateUniversalTimelineForTransaction(INITIAL_EDITOR_PROJECT, {
      label: 'Add move source',
      commands: [
        {
          type: 'timeline.addTrack',
          payload: {
            compositionId: 'root',
            track: {
              id: 'source-track',
              kind: 'video',
              order: 1,
              enabled: true,
              clips: [
                {
                  id: 'movable',
                  kind: 'video',
                  assetId: 'product-still',
                  startUs: 0,
                  durationUs: 1_000_000,
                  sourceInUs: 0,
                },
              ],
            },
          },
        },
      ],
    });
    const moved = updateUniversalTimelineForTransaction(added, {
      label: 'Move source',
      commands: [
        {
          type: 'timeline.moveElement',
          payload: {
            compositionId: 'root',
            sourceTrackId: 'source-track',
            targetTrackId: 'caption-track',
            clipId: 'movable',
            newStartUs: 2_000_000,
          },
        },
      ],
    });
    expect(moved.universalTimeline?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'movable', trackId: 'caption-track', withinTrackOrder: 1 }),
      ]),
    );
  });
});
