import { describe, expect, it, vi } from 'vitest';
import { emptySpikeProject } from '@joy-media/test-fixtures';
import {
  addTimelineMarkerAtPlayhead,
  buildTimelineFileImportTransactions,
  openTimelineAssetLibrary,
} from './TimelinePanel.js';
import {
  extractTimelineDroppedFiles,
  isTimelineEmptyStateActivationKey,
} from './TimelineEmptyState.js';

describe('timeline media intake', () => {
  it('builds one real-track insertion per dropped file, opens Assets on request, and routes marker additions through the shared command helper', () => {
    const project = emptySpikeProject({ trackCount: 2, durationUs: 30_000_000 });
    const composition = project.compositions[project.rootCompositionId]!;
    const transactions = buildTimelineFileImportTransactions({
      composition,
      trackFlags: [
        { id: 'track-0', order: 0, heightPx: 44, locked: false, muted: false, solo: false },
        { id: 'track-1', order: 1, heightPx: 44, locked: true, muted: false, solo: false },
      ],
      playheadUs: 1_000_000,
      files: [new File(['video'], 'intro.mp4', { type: 'video/mp4' })],
      createAssetId: (file) => `asset-${file.name}`,
      now: () => 1234,
    });

    expect(transactions).toHaveLength(1);
    expect(transactions[0]?.commands).toHaveLength(1);
    expect(transactions[0]?.commands[0]).toMatchObject({
      type: 'timeline.insertClip',
      payload: {
        compositionId: composition.id,
        trackId: 'track-0',
        clip: {
          id: 'clip-asset-intro.mp4-1234',
          assetId: 'asset-intro.mp4',
          startUs: 1_000_000,
          durationUs: 5_000_000,
        },
      },
    });
    expect(
      transactions
        .flatMap((transaction) => transaction.commands)
        .some((command) => {
          const payload = command.payload as { trackId?: string } | undefined;
          return payload?.trackId === '';
        }),
    ).toBe(false);

    const openAssets = vi.fn();
    openTimelineAssetLibrary(openAssets);
    expect(openAssets).toHaveBeenCalledTimes(1);

    const addMarker = vi.fn();
    addTimelineMarkerAtPlayhead(addMarker, 1_000_000, 0);
    expect(addMarker).toHaveBeenCalledWith(1_000_000, 'Marker 1');
  });

  it('consumes dropped files and treats Enter and Space as empty-state activation keys', () => {
    const droppedFile = new File(['image'], 'sticker.png', { type: 'image/png' });
    const files = extractTimelineDroppedFiles({
      types: ['Files'],
      files: {
        0: droppedFile,
        length: 1,
        item: () => droppedFile,
      } as FileList,
    });

    expect(files).toEqual([droppedFile]);
    expect(isTimelineEmptyStateActivationKey('Enter')).toBe(true);
    expect(isTimelineEmptyStateActivationKey(' ')).toBe(true);
    expect(isTimelineEmptyStateActivationKey('Escape')).toBe(false);
  });

  it('skips an incompatible first row and inserts audio onto a later compatible track', () => {
    const project = emptySpikeProject({ trackCount: 0, durationUs: 30_000_000 });
    const composition = {
      ...project.compositions[project.rootCompositionId]!,
      tracks: [
        { id: 'V1', kind: 'video', order: 0, enabled: true, clips: [] },
        { id: 'A1-voice', kind: 'video', order: 1, enabled: true, clips: [] },
      ],
    };
    const transactions = buildTimelineFileImportTransactions({
      composition,
      trackFlags: [
        { id: 'V1', order: 0, heightPx: 44, locked: false, muted: false, solo: false },
        { id: 'A1-voice', order: 1, heightPx: 44, locked: false, muted: false, solo: false },
      ],
      playheadUs: 2_000_000,
      files: [new File(['audio'], 'voice.mp3', { type: 'audio/mpeg' })],
      createAssetId: () => 'asset-voice',
      now: () => 2222,
    });

    expect(transactions[0]?.commands[0]).toMatchObject({
      type: 'timeline.insertClip',
      payload: {
        trackId: 'A1-voice',
        clip: {
          id: 'voice-asset-voice-2222',
          assetId: 'asset-voice',
          startUs: 2_000_000,
        },
      },
    });
  });

  it('creates a new audio track when no compatible unlocked row exists', () => {
    const project = emptySpikeProject({ trackCount: 0, durationUs: 30_000_000 });
    const composition = {
      ...project.compositions[project.rootCompositionId]!,
      tracks: [{ id: 'V1', kind: 'video', order: 0, enabled: true, clips: [] }],
    };
    const transactions = buildTimelineFileImportTransactions({
      composition,
      trackFlags: [{ id: 'V1', order: 0, heightPx: 44, locked: false, muted: false, solo: false }],
      playheadUs: 3_000_000,
      files: [new File(['audio'], 'music.wav', { type: 'audio/wav' })],
      createAssetId: () => 'asset-music',
      now: () => 3333,
    });

    expect(transactions[0]?.commands[0]).toMatchObject({
      type: 'timeline.addTrack',
      payload: {
        track: {
          id: 'A1',
          order: 1,
          clips: [
            {
              id: 'voice-asset-music-3333',
              assetId: 'asset-music',
              startUs: 3_000_000,
            },
          ],
        },
      },
    });
  });
});
