import { describe, expect, it, vi } from 'vitest';
import { createTextLayer } from './state/layerFactory.js';
import { createBlankScene } from '@joy-media/motion-core';
import { motionSceneToTimelineTracks } from './motionSceneToTimelineTracks.js';

describe('Motion Studio timeline visibility controls', () => {
  it('maps layer visibility to the shared TimelineCanvas control', () => {
    const visibleLayer = { ...createTextLayer('visible'), id: 'visible', visible: true };
    const hiddenLayer = { ...createTextLayer('hidden'), id: 'hidden', visible: false };
    const document = { ...createBlankScene('visibility'), layers: [visibleLayer, hiddenLayer] };
    const onToggleVisibility = vi.fn();

    const tracks = motionSceneToTimelineTracks(document, {
      onToggleVisibility,
      onToggleLocked: vi.fn(),
    });

    expect(tracks[0]?.controls?.visible).toBe(false);
    expect(tracks[1]?.controls?.visible).toBe(true);
    tracks[0]?.controls?.onToggle('visible');
    expect(onToggleVisibility).toHaveBeenCalledWith('hidden');
  });
});
