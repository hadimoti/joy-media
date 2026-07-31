import { describe, expect, it } from 'vitest';
import {
  activeVideoClipAt,
  nextVideoClipAtOrAfter,
  type PlaybackClip,
  type PlaybackProject,
} from './timeline-playback.js';

/**
 * Regression guards for the playback issue: the whole timeline must keep
 * playing across clip boundaries and gaps, not stop after the first clip.
 */

function clip(id: string, kind = 'video', startUs = 0, durationUs = 1_000_000) {
  return { kind, id, startUs, durationUs };
}

function project(tracks: Array<{ id: string; clips: PlaybackClip[] }>): PlaybackProject {
  return {
    rootCompositionId: 'root',
    compositions: {
      root: {
        id: 'root',
        durationUs: 30_000_000,
        tracks: tracks.map((t) => ({ id: t.id, clips: t.clips })),
      },
    },
  };
}

describe('nextVideoClipAtOrAfter (gap-tolerant playback advance)', () => {
  it('skips a gap and returns the next clip after a clip boundary', () => {
    const p = project([
      {
        id: 'V1',
        clips: [
          clip('a', 'video', 0, 5_000_000),
          clip('b', 'video', 7_000_000, 3_000_000), // 2s gap after clip a
        ],
      },
    ]);

    // At end of clip a (5s) there is a gap until 7s — must advance to clip b.
    const next = nextVideoClipAtOrAfter(p, 5_000_000);
    expect(next?.id).toBe('b');
  });

  it('returns the next contiguously-touching clip at the exact boundary', () => {
    const p = project([
      {
        id: 'V1',
        clips: [
          clip('a', 'video', 0, 5_000_000),
          clip('b', 'video', 5_000_000, 5_000_000), // touches exactly
        ],
      },
    ]);

    expect(nextVideoClipAtOrAfter(p, 5_000_000)?.id).toBe('b');
  });

  it('does not stop at a clip end when a later video clip exists', () => {
    const p = project([
      { id: 'V1', clips: [clip('only', 'video', 0, 5_000_000)] },
      { id: 'V2', clips: [clip('later', 'video', 6_000_000, 4_000_000)] },
    ]);

    expect(nextVideoClipAtOrAfter(p, 5_000_000)?.id).toBe('later');
  });

  it('returns undefined only when nothing plays at/after the time', () => {
    const p = project([{ id: 'V1', clips: [clip('a', 'video', 0, 5_000_000)] }]);
    expect(nextVideoClipAtOrAfter(p, 5_000_000)).toBeUndefined();
  });

  it('ignores non-video clips when choosing the next clip', () => {
    const p = project([
      {
        id: 'V1',
        clips: [
          clip('a', 'video', 0, 5_000_000),
          clip('caption', 'caption', 6_000_000, 2_000_000),
          clip('b', 'video', 7_000_000, 3_000_000),
        ],
      },
    ]);

    expect(nextVideoClipAtOrAfter(p, 5_000_000)?.id).toBe('b');
  });
});

describe('activeVideoClipAt', () => {
  it('returns the clip covering the playhead', () => {
    const p = project([{ id: 'V1', clips: [clip('a', 'video', 0, 5_000_000)] }]);
    expect(activeVideoClipAt(p, 2_000_000)?.id).toBe('a');
    expect(activeVideoClipAt(p, 5_000_000)).toBeUndefined(); // not past its end
  });
});
