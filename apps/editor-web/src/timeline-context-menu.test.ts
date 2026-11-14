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

  it('does not expose add-track, while removal stays explicit and guarded', () => {
    const items = buildTrackHeaderContextMenu(vi.fn(), vi.fn(), vi.fn(), true, true);
    expect(items.some((item) => /add track/i.test(item.label))).toBe(false);
    expect(items.find((item) => item.label === 'Remove Track')).toMatchObject({ disabled: false });
  });

  it('uses visibility language for the track output toggle', () => {
    const onToggleVisibility = vi.fn();
    const visible = buildTrackHeaderContextMenu(vi.fn(), vi.fn(), onToggleVisibility, true, true);
    const hidden = buildTrackHeaderContextMenu(vi.fn(), vi.fn(), onToggleVisibility, false, true);

    const visibleToggle = visible.find((item) => item.label === 'Hide Track');
    const hiddenToggle = hidden.find((item) => item.label === 'Show Track');
    expect(visibleToggle).toBeDefined();
    expect(hiddenToggle).toBeDefined();
    visibleToggle?.action?.();
    hiddenToggle?.action?.();
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

  it('routes the clip menu Copy and Cut to the panel callbacks, which act on the whole selection', () => {
    const project = withClips(emptySpikeProject({ trackCount: 1 }), 'track-0', [
      makeVideoClip('clip-a', 0, 2 * SECOND_US),
      makeVideoClip('clip-b', 2 * SECOND_US, 2 * SECOND_US),
    ]);
    const track = project.compositions.root!.tracks[0]!;
    const clip = track.clips[0]!;
    const copy = vi.fn();
    const cut = vi.fn();
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
      false,
      { copy, cut },
    );

    items.find((item) => item.label === 'Copy clip')?.action?.();
    items.find((item) => item.label === 'Cut clip')?.action?.();

    expect(copy).toHaveBeenCalledOnce();
    expect(cut).toHaveBeenCalledOnce();
    // The menu never runs a single-clip removal of its own: the panel's whole-selection cut does.
    expect(execute).not.toHaveBeenCalled();
  });

  it('disables the clip menu Cut when the panel supplies no selection callback', () => {
    const project = withClips(emptySpikeProject({ trackCount: 1 }), 'track-0', [
      makeVideoClip('clip-a', 0, 2 * SECOND_US),
    ]);
    const track = project.compositions.root!.tracks[0]!;
    const items = buildClipContextMenu(
      {
        project,
        compositionId: 'root',
        playheadUs: SECOND_US,
        selectedClip: { track, clip: track.clips[0]! },
        selectedTrackIds: ['track-0'],
      },
      vi.fn(),
    );

    expect(items.find((item) => item.label === 'Cut clip')).toMatchObject({ disabled: true });
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
