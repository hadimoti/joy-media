import { describe, expect, it, vi } from 'vitest';
import {
  buildEmptyCanvasContextMenu,
  buildRulerContextMenu,
  buildTrackHeaderContextMenu,
} from './commands/timeline-commands.js';

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

  it('forwards the ruler time to the marker command', () => {
    const onAddMarker = vi.fn();
    const [item] = buildRulerContextMenu(onAddMarker, 2_500_000);

    item?.action?.();

    expect(item?.label).toContain('00:00:02:15');
    expect(onAddMarker).toHaveBeenCalledWith(2_500_000);
  });
});
