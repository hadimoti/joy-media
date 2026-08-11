import { describe, expect, it, vi } from 'vitest';
import {
  buildClipContextMenu,
  buildEmptyCanvasContextMenu,
  buildRulerContextMenu,
  buildTrackHeaderContextMenu,
} from './commands/timeline-commands.js';
import { emptySpikeProject, makeVideoClip, SECOND_US, withClips } from '@joy-media/test-fixtures';

describe('timeline context menu commands', () => {
  it('executes the empty-canvas media actions', () => {
    const onImport = vi.fn();
    const onOpenLibrary = vi.fn();
    const items = buildEmptyCanvasContextMenu(onImport, onOpenLibrary);

    items[0]?.action?.();
    items[1]?.action?.();

    expect(onImport).toHaveBeenCalledOnce();
    expect(onOpenLibrary).toHaveBeenCalledOnce();
  });

  it('only enables removal when the caller confirms the track is removable', () => {
    const onRemove = vi.fn();
    const removable = buildTrackHeaderContextMenu(vi.fn(), onRemove, vi.fn(), true, true);
    const protectedTrack = buildTrackHeaderContextMenu(vi.fn(), onRemove, vi.fn(), true, false);

    expect(removable[1]).toMatchObject({ label: 'Remove Track', disabled: false });
    expect(protectedTrack[1]).toMatchObject({ label: 'Remove Track', disabled: true });
    removable[1]?.action?.();
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it('uses visibility language for the track output toggle', () => {
    const onToggleVisibility = vi.fn();
    const visible = buildTrackHeaderContextMenu(vi.fn(), vi.fn(), onToggleVisibility, true, true);
    const hidden = buildTrackHeaderContextMenu(vi.fn(), vi.fn(), onToggleVisibility, false, true);

    expect(visible[3]).toMatchObject({ label: 'Hide Track' });
    expect(hidden[3]).toMatchObject({ label: 'Show Track' });
    visible[3]?.action?.();
    hidden[3]?.action?.();
    expect(onToggleVisibility).toHaveBeenNthCalledWith(1, false);
    expect(onToggleVisibility).toHaveBeenNthCalledWith(2, true);
  });

  it('forwards the ruler time to the marker command', () => {
    const onAddMarker = vi.fn();
    const [item] = buildRulerContextMenu(onAddMarker, 2_500_000);

    item?.action?.();

    expect(item?.label).toContain('00:00:02:15');
    expect(onAddMarker).toHaveBeenCalledWith(2_500_000);
  });

  it('offers an executable reverse action for a non-frozen video clip', () => {
    const project = withClips(emptySpikeProject({ trackCount: 1 }), 'track-0', [
      makeVideoClip('clip-a', 0, 2 * SECOND_US),
    ]);
    const track = project.compositions.root!.tracks[0]!;
    const clip = track.clips[0]!;
    const execute = vi.fn();
    const items = buildClipContextMenu(
      {
        project,
        compositionId: 'root',
        playheadUs: SECOND_US,
        selectedClip: { track, clip },
        selectedTrackIds: ['track-0'],
      },
      execute,
    );

    const reverse = items.find((item) => item.label === 'Reverse clip');
    reverse?.action?.();

    expect(execute).toHaveBeenCalledWith({
      type: 'timeline.toggleClipReverse',
      payload: { compositionId: 'root', trackId: 'track-0', clipId: 'clip-a' },
    });
  });

  it('does not offer a rate mutation for a frozen clip that cannot undo to motion', () => {
    const project = withClips(emptySpikeProject({ trackCount: 1 }), 'track-0', [
      { ...makeVideoClip('freeze-a', 0, 2 * SECOND_US), playbackRate: 0 },
    ]);
    const track = project.compositions.root!.tracks[0]!;
    const clip = track.clips[0]!;
    const items = buildClipContextMenu(
      {
        project,
        compositionId: 'root',
        playheadUs: SECOND_US,
        selectedClip: { track, clip },
        selectedTrackIds: ['track-0'],
      },
      vi.fn(),
    );

    expect(items.some((item) => item.label === 'Set playback rate…')).toBe(false);
  });
});
