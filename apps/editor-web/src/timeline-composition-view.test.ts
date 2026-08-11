import { describe, expect, it } from 'vitest';
import {
  emptySpikeProject,
  makeCompositionClip,
  makeVideoClip,
  withClips,
} from '@joy-media/test-fixtures';
import {
  timelineCompositionView,
  timelineViewLocalTime,
  timelineViewRootTime,
} from './timeline-composition-view.js';

describe('timelineCompositionView', () => {
  it('maps a compound child timeline to and from root coordinates', () => {
    const childBase = emptySpikeProject({ durationUs: 4_000_000 });
    const child = withClips(
      {
        ...childBase,
        rootCompositionId: 'child',
        compositions: { child: { ...childBase.compositions.root!, id: 'child' } },
      },
      'track-0',
      [makeVideoClip('inside', 0, 4_000_000)],
    ).compositions.child!;
    const root = withClips(emptySpikeProject({ durationUs: 12_000_000 }), 'track-0', [
      makeCompositionClip('compound', 5_000_000, 4_000_000, 'child'),
    ]);
    const project = { ...root, compositions: { ...root.compositions, child } };

    const view = timelineCompositionView(project, 'child');
    expect(view?.rootOffsetUs).toBe(5_000_000);
    expect(view?.path).toEqual(['root', 'child']);
    expect(timelineViewLocalTime(view!, 6_250_000)).toBe(1_250_000);
    expect(timelineViewRootTime(view!, 1_250_000)).toBe(6_250_000);
  });

  it('uses effective composition duration rather than a stale declared duration', () => {
    const childBase = emptySpikeProject({ durationUs: 1_000_000 });
    const child = withClips(
      {
        ...childBase,
        rootCompositionId: 'child',
        compositions: { child: { ...childBase.compositions.root!, id: 'child' } },
      },
      'track-0',
      [makeVideoClip('inside', 0, 4_000_000)],
    ).compositions.child!;
    const root = withClips(emptySpikeProject({ durationUs: 10_000_000 }), 'track-0', [
      makeCompositionClip('compound', 2_000_000, 4_000_000, 'child'),
    ]);
    const project = { ...root, compositions: { ...root.compositions, child } };
    const view = timelineCompositionView(project, 'child')!;

    expect(timelineViewLocalTime(view, 5_500_000)).toBe(3_500_000);
  });
});
