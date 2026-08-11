import { describe, expect, it } from 'vitest';
import {
  emptySpikeProject,
  makeCompositionClip,
  makeVideoClip,
  withClips,
} from '@joy-media/test-fixtures';
import {
  flattenRootTimelineVideoClips,
  rootTimelineVideoClipAt,
  withFlattenedRootTimeline,
} from './timeline-nested-playback.js';

describe('nested timeline playback projection', () => {
  it('projects a compound child video into root time without mutating the authoring child', () => {
    const childBase = emptySpikeProject({ durationUs: 4_000_000 });
    const child = withClips(
      {
        ...childBase,
        id: 'child-project',
        rootCompositionId: 'child',
        compositions: {
          child: { ...childBase.compositions.root!, id: 'child' },
        },
      },
      'track-0',
      [makeVideoClip('child-video', 0, 4_000_000, { assetId: 'child.mp4', sourceInUs: 1_000_000 })],
    ).compositions.child!;
    const rootBase = emptySpikeProject({ durationUs: 12_000_000 });
    const root = withClips(rootBase, 'track-0', [
      makeVideoClip('intro', 0, 5_000_000),
      makeCompositionClip('compound', 5_000_000, 4_000_000, 'child'),
    ]);
    const project = { ...root, compositions: { ...root.compositions, child } };

    const leaves = flattenRootTimelineVideoClips(project);
    expect(leaves.map((clip) => [clip.id, clip.startUs, clip.durationUs, clip.sourceInUs])).toEqual(
      [
        ['intro', 0, 5_000_000, 5_000_000],
        ['child-video', 5_000_000, 4_000_000, 1_000_000],
      ],
    );
    expect(rootTimelineVideoClipAt(project, 6_500_000)?.id).toBe('child-video');
    expect(project.compositions.child!.tracks[0]!.clips[0]!.startUs).toBe(0);

    const playback = withFlattenedRootTimeline(project);
    expect(playback.compositions.root!.tracks[0]!.clips.map((clip) => clip.id)).toEqual([
      'intro',
      'child-video',
    ]);
  });

  it('clips a child leaf to a composition clip window and preserves the correct source frame', () => {
    const childBase = emptySpikeProject({ durationUs: 10_000_000 });
    const child = withClips(
      {
        ...childBase,
        id: 'child-project',
        rootCompositionId: 'child',
        compositions: { child: { ...childBase.compositions.root!, id: 'child' } },
      },
      'track-0',
      [makeVideoClip('child-video', 0, 10_000_000, { sourceInUs: 2_000_000 })],
    ).compositions.child!;
    const root = withClips(emptySpikeProject({ durationUs: 10_000_000 }), 'track-0', [
      makeCompositionClip('compound', 3_000_000, 4_000_000, 'child', 2_000_000),
    ]);
    const project = { ...root, compositions: { ...root.compositions, child } };

    const leaf = flattenRootTimelineVideoClips(project)[0]!;
    expect([leaf.startUs, leaf.durationUs, leaf.sourceInUs]).toEqual([
      3_000_000, 4_000_000, 4_000_000,
    ]);
  });
});
