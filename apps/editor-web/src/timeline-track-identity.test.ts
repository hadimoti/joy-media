import { describe, expect, it } from 'vitest';
import { emptySpikeProject } from '@joy-media/test-fixtures';
import { allocateTimelineTrackId } from './timeline-track-identity.js';

describe('allocateTimelineTrackId', () => {
  it('keeps ids monotonic after a non-tail track is removed', () => {
    const project = emptySpikeProject({ trackCount: 0 });
    const composition = {
      ...project.compositions.root!,
      tracks: [
        { id: 'V1', kind: 'video' as const, order: 0, enabled: true, clips: [] },
        { id: 'V3', kind: 'video' as const, order: 1, enabled: true, clips: [] },
      ],
    };
    expect(allocateTimelineTrackId(composition, 'video')).toBe('V4');
  });

  it('reserves ids for rapid commands built against the same render', () => {
    const project = emptySpikeProject({ trackCount: 0 });
    const composition = project.compositions.root!;
    expect(allocateTimelineTrackId(composition, 'video')).toBe('V1');
    expect(allocateTimelineTrackId(composition, 'video')).toBe('V2');
    expect(allocateTimelineTrackId(composition, 'audio')).toBe('A1');
  });
});
