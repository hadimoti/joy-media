import { describe, expect, it, vi } from 'vitest';
import { buildTrackHeaderContextMenu } from './timeline-commands.js';

describe('buildTrackHeaderContextMenu', () => {
  const buildMenu = (canRemoveTrack: boolean) =>
    buildTrackHeaderContextMenu('track-1', vi.fn(), vi.fn(), vi.fn(), true, canRemoveTrack);

  it('enables Remove Track when the selected track is empty and another track remains', () => {
    const removeTrack = buildMenu(true).find((item) => item.label === 'Remove Track');

    expect(removeTrack?.disabled).toBe(false);
  });

  it('disables Remove Track when removing the selected track is invalid', () => {
    const removeTrack = buildMenu(false).find((item) => item.label === 'Remove Track');

    expect(removeTrack?.disabled).toBe(true);
  });
});
