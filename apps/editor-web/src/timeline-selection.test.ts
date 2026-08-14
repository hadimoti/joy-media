import { describe, expect, it } from 'vitest';
import { emptySpikeProject, makeVideoClip, withClips } from '@joy-media/test-fixtures';
import { reconcileTimelineSelection } from './timeline-selection.js';

describe('reconcileTimelineSelection', () => {
  it('preserves live clip order and removes deleted history targets', () => {
    const project = withClips(emptySpikeProject(), 'track-0', [
      makeVideoClip('live-a', 0, 1_000_000),
      makeVideoClip('live-b', 1_000_000, 1_000_000),
    ]);

    expect(reconcileTimelineSelection(project, ['deleted-adjust', 'live-b', 'live-a'])).toEqual([
      'live-b',
      'live-a',
    ]);
  });
});
