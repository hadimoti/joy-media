import { describe, expect, it, vi } from 'vitest';
import { emptySpikeProject, makeVideoClip, withClips } from '@joy-media/test-fixtures';
import { buildClipContextMenu, buildTrackHeaderContextMenu } from './timeline-commands.js';

describe('buildTrackHeaderContextMenu', () => {
  const buildMenu = (canRemoveTrack: boolean) =>
    buildTrackHeaderContextMenu(vi.fn(), vi.fn(), vi.fn(), true, canRemoveTrack);

  it('enables Remove Track only when the caller proves removal is valid', () => {
    const removeTrack = buildMenu(true).find((item) => item.label === 'Remove Track');

    expect(removeTrack).toMatchObject({ disabled: false });
  });

  it('keeps Remove Track visible but disabled for invalid track states', () => {
    const removeTrack = buildMenu(false).find((item) => item.label === 'Remove Track');

    expect(removeTrack).toMatchObject({ disabled: true });
  });

  it('preserves the removal callback for the enabled menu item', () => {
    const action = vi.fn();
    const menu = buildTrackHeaderContextMenu(vi.fn(), action, vi.fn(), true, true);

    expect(menu.find((item) => item.label === 'Remove Track')?.disabled).toBe(false);
    menu.find((item) => item.label === 'Remove Track')?.action?.();
    expect(action).toHaveBeenCalledOnce();
  });

  it('disables every clip mutation from a locked track context menu', () => {
    const project = withClips(emptySpikeProject({ trackCount: 1 }), 'track-0', [
      makeVideoClip('clip-1', 0, 5_000_000),
    ]);
    const composition = project.compositions.root!;
    const track = composition.tracks[0]!;
    const items = buildClipContextMenu(
      {
        project,
        compositionId: 'root',
        playheadUs: 1_000_000,
        selectedTrackIds: [track.id],
        selectedClip: { track, clip: track.clips[0]! },
      },
      vi.fn(),
      true,
    );
    expect(
      items.filter((item) => item.action && !item.dividerBefore).every((item) => item.disabled),
    ).toBe(true);
  });
});
