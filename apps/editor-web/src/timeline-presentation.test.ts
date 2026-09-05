import type { CommandTransaction } from '@joy-media/commands';
import { validateUniversalTimelineDocument } from '@joy-media/project-schema';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { describe, expect, it } from 'vitest';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
import { audioStateFromProject, prepareTimelinePresentation } from './timeline-presentation.js';
import { readClipObjectMap } from './sticker-bindings.js';

function projectWithIntroPlacement() {
  return {
    ...INITIAL_EDITOR_PROJECT,
    universalTimeline: {
      schemaVersion: 1 as const,
      items: [
        {
          id: 'intro',
          compositionId: 'root',
          trackId: 'track-0',
          elementKind: 'video' as const,
          startUs: 0,
          durationUs: 10_000_000,
          source: { kind: 'asset' as const, id: 'intro' },
          withinTrackOrder: 0,
        },
        {
          id: 'intro:object:intro-title',
          compositionId: 'root',
          trackId: 'track-0',
          elementKind: 'text' as const,
          startUs: 0,
          durationUs: 10_000_000,
          source: { kind: 'object' as const, id: 'intro-title' },
          withinTrackOrder: 1,
        },
      ],
    },
  };
}

function timelineWithIntroOnly(playbackRate?: number) {
  const timeline = buildReferenceSpikeProject();
  const root = timeline.compositions[timeline.rootCompositionId]!;
  return {
    ...timeline,
    compositions: {
      ...timeline.compositions,
      [timeline.rootCompositionId]: {
        ...root,
        tracks: root.tracks.map((track) =>
          track.id === 'track-0'
            ? {
                ...track,
                clips: track.clips
                  .filter((clip) => clip.id === 'intro')
                  .map((clip) => (playbackRate === undefined ? clip : { ...clip, playbackRate })),
              }
            : track,
        ),
      },
    },
  };
}

describe('shared timeline presentation preparation', () => {
  it('preserves split bindings and updates the universal placement item', () => {
    const transaction: CommandTransaction = {
      label: 'split intro',
      commands: [
        {
          type: 'timeline.splitClip',
          payload: {
            compositionId: 'root',
            trackId: 'track-0',
            clipId: 'intro',
            atUs: 2_000_000,
            newClipId: 'intro-right',
          },
        },
      ],
    };
    const prepared = prepareTimelinePresentation(
      projectWithIntroPlacement(),
      audioStateFromProject(INITIAL_EDITOR_PROJECT),
      timelineWithIntroOnly(2),
      transaction,
    );
    expect(readClipObjectMap(prepared.project)['intro-right']).toBe('intro-title');
    expect(prepared.project.universalTimeline?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'intro', startUs: 0, durationUs: 2_000_000 }),
        expect.objectContaining({
          id: 'intro-right',
          startUs: 2_000_000,
          durationUs: 8_000_000,
          sourceInUs: 9_000_000,
        }),
        expect.objectContaining({ id: 'intro-right:object:intro-title' }),
      ]),
    );
    expect(validateUniversalTimelineDocument(prepared.project.universalTimeline!)).toEqual([]);
  });

  it('keeps duplicate and freeze presentation propagation in the shared seam', () => {
    const timeline = buildReferenceSpikeProject();
    const source = projectWithIntroPlacement();
    const duplicate: CommandTransaction = {
      label: 'duplicate intro',
      commands: [
        {
          type: 'timeline.duplicateClip',
          payload: {
            compositionId: 'root',
            trackId: 'track-0',
            clipId: 'intro',
            newClipId: 'intro-copy',
          },
        },
      ],
    };
    const duplicated = prepareTimelinePresentation(
      source,
      audioStateFromProject(INITIAL_EDITOR_PROJECT),
      timelineWithIntroOnly(),
      duplicate,
    );
    expect(readClipObjectMap(duplicated.project)['intro-copy']).toBe('intro-title');
    expect(duplicated.project.universalTimeline?.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'intro-copy' })]),
    );
    expect(validateUniversalTimelineDocument(duplicated.project.universalTimeline!)).toEqual([]);

    const freeze: CommandTransaction = {
      label: 'freeze intro',
      commands: [
        {
          type: 'timeline.freezeFrame',
          payload: {
            compositionId: 'root',
            trackId: 'track-0',
            clipId: 'intro',
            atUs: 2_000_000,
            holdUs: 500_000,
            freezeClipId: 'intro-freeze',
            rightClipId: 'intro-after-freeze',
          },
        },
      ],
    };
    const frozen = prepareTimelinePresentation(
      source,
      audioStateFromProject(INITIAL_EDITOR_PROJECT),
      timeline,
      freeze,
    );
    expect(readClipObjectMap(frozen.project)).toMatchObject({
      'intro-freeze': 'intro-title',
      'intro-after-freeze': 'intro-title',
    });
    expect(frozen.project.universalTimeline?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'intro-freeze', durationUs: 500_000 }),
        expect.objectContaining({ id: 'intro-after-freeze' }),
      ]),
    );
    expect(validateUniversalTimelineDocument(frozen.project.universalTimeline!)).toEqual([]);
  });

  it('cleans every removed clip when one compound transaction carries multiple removals', () => {
    const project = {
      ...projectWithIntroPlacement(),
      universalTimeline: {
        schemaVersion: 1 as const,
        items: [
          ...projectWithIntroPlacement().universalTimeline!.items,
          {
            id: 'product',
            compositionId: 'root',
            trackId: 'track-0',
            elementKind: 'video' as const,
            startUs: 10_000_000,
            durationUs: 10_000_000,
            source: { kind: 'asset' as const, id: 'product' },
            withinTrackOrder: 1,
          },
        ],
      },
    };
    const prepared = prepareTimelinePresentation(
      project,
      audioStateFromProject(INITIAL_EDITOR_PROJECT),
      buildReferenceSpikeProject(),
      {
        label: 'remove clips',
        commands: [
          {
            type: 'timeline.removeClip',
            payload: { compositionId: 'root', trackId: 'track-0', clipId: 'intro' },
          },
          {
            type: 'timeline.removeClip',
            payload: { compositionId: 'root', trackId: 'track-0', clipId: 'product' },
          },
        ],
      },
    );
    expect(prepared.project.universalTimeline?.items).toEqual([]);
  });

  it('advances the scratch timeline for move-then-split and split-derived-then-split', () => {
    const moveThenSplit = prepareTimelinePresentation(
      projectWithIntroPlacement(),
      audioStateFromProject(INITIAL_EDITOR_PROJECT),
      buildReferenceSpikeProject(),
      {
        label: 'move then split',
        commands: [
          {
            type: 'timeline.trimClipEnd',
            payload: {
              compositionId: 'root',
              trackId: 'track-0',
              clipId: 'intro',
              newEndUs: 8_000_000,
            },
          },
          {
            type: 'timeline.moveClip',
            payload: {
              compositionId: 'root',
              trackId: 'track-0',
              clipId: 'intro',
              newStartUs: 1_000_000,
            },
          },
          {
            type: 'timeline.splitClip',
            payload: {
              compositionId: 'root',
              trackId: 'track-0',
              clipId: 'intro',
              atUs: 3_000_000,
              newClipId: 'intro-moved-right',
            },
          },
        ],
      },
    );
    expect(moveThenSplit.project.universalTimeline?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'intro', startUs: 1_000_000, durationUs: 2_000_000 }),
        expect.objectContaining({ id: 'intro-moved-right', startUs: 3_000_000 }),
      ]),
    );
    expect(validateUniversalTimelineDocument(moveThenSplit.project.universalTimeline!)).toEqual([]);

    const splitDerived = prepareTimelinePresentation(
      projectWithIntroPlacement(),
      audioStateFromProject(INITIAL_EDITOR_PROJECT),
      buildReferenceSpikeProject(),
      {
        label: 'split twice',
        commands: [
          {
            type: 'timeline.splitClip',
            payload: {
              compositionId: 'root',
              trackId: 'track-0',
              clipId: 'intro',
              atUs: 2_000_000,
              newClipId: 'intro-right',
            },
          },
          {
            type: 'timeline.splitClip',
            payload: {
              compositionId: 'root',
              trackId: 'track-0',
              clipId: 'intro-right',
              atUs: 5_000_000,
              newClipId: 'intro-right-right',
            },
          },
        ],
      },
    );
    expect(splitDerived.project.universalTimeline?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'intro-right', startUs: 2_000_000, durationUs: 3_000_000 }),
        expect.objectContaining({ id: 'intro-right-right', startUs: 5_000_000 }),
      ]),
    );
    expect(validateUniversalTimelineDocument(splitDerived.project.universalTimeline!)).toEqual([]);
    expect(readClipObjectMap(splitDerived.project)['intro-right-right']).toBe('intro-title');
  });
});
