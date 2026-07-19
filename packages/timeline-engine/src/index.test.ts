import { describe, expect, it } from 'vitest';
import {
  commitMove,
  pixelToTime,
  previewMove,
  rippleDelete,
  snapTime,
  splitCommand,
  timeToPixel,
  toggleSelection,
  trimCommand,
  toggleTrackFlag,
  virtualTracks,
  visibleRange,
} from './index.js';
describe('timeline coordinates', () => {
  it('round trips coordinates and snaps inside the pixel threshold', () => {
    const viewport = { originUs: 1_000_000, pixelsPerSecond: 100 };
    expect(pixelToTime(timeToPixel(2_500_000, viewport), viewport)).toBe(2_500_000);
    expect(snapTime(2_049_000, [2_000_000], viewport, 8)).toBe(2_000_000);
    expect(snapTime(2_090_000, [2_000_000], viewport, 8)).toBe(2_090_000);
  });
  it('keeps drag previews transient and emits one snapped move command on commit', () => {
    const viewport = { originUs: 0, pixelsPerSecond: 100 };
    const preview = previewMove('clip-a', 0, 1_049_000, [1_000_000], viewport);
    expect(preview.snappedStartUs).toBe(1_000_000);
    expect(commitMove('root', 'track-0', preview)).toMatchObject({
      type: 'timeline.moveClip',
      payload: { newStartUs: 1_000_000 },
    });
    expect(visibleRange(viewport, 250)).toEqual({ startUs: 0, endUs: 2_500_000 });
  });
  it('builds selection, trim/split, and atomic ripple-delete intent', () => {
    expect(toggleSelection({ clipIds: ['a'] }, 'b')).toEqual({ clipIds: ['a', 'b'] });
    expect(trimCommand('root', 't', 'a', 'end', 10)).toMatchObject({
      type: 'timeline.trimClipEnd',
    });
    expect(splitCommand('root', 't', 'a', 5, 'a-2')).toMatchObject({ type: 'timeline.splitClip' });
    expect(
      rippleDelete(
        'root',
        't',
        [
          { id: 'a', startUs: 0, durationUs: 10 },
          { id: 'b', startUs: 20, durationUs: 10 },
        ],
        'a',
      ),
    ).toMatchObject({
      commands: [
        { type: 'timeline.removeClip' },
        { type: 'timeline.moveClip', payload: { clipId: 'b', newStartUs: 10 } },
      ],
    });
  });
  it('virtualizes visible track rows and keeps track controls ephemeral', () => {
    const tracks = [
      { id: 'a', heightPx: 20, locked: false, muted: false, solo: false },
      { id: 'b', heightPx: 20, locked: false, muted: false, solo: false },
      { id: 'c', heightPx: 20, locked: false, muted: false, solo: false },
    ];
    expect(virtualTracks(tracks, 20, 20).map((track) => track.id)).toEqual(['a', 'b', 'c']);
    expect(toggleTrackFlag(tracks[0]!, 'muted').muted).toBe(true);
  });
});
