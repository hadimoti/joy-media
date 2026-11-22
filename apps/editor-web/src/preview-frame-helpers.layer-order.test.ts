import { describe, expect, it } from 'vitest';
import type { JoyProjectV1, SpikeProject } from '@joy-media/project-schema';
import { trackLayerOrder } from './preview-frame-helpers.js';

interface TrackSpec {
  readonly order: number;
  readonly clips: readonly { id: string; startUs?: number; durationUs?: number }[];
}

function timeline(tracks: readonly TrackSpec[], compositionId = 'root'): SpikeProject {
  return {
    compositions: {
      [compositionId]: {
        tracks: tracks.map((track, index) => ({
          id: `t${index}`,
          order: track.order,
          clips: track.clips.map((clip) => ({
            startUs: 0,
            durationUs: 1_000_000,
            ...clip,
          })),
        })),
      },
    },
  } as unknown as SpikeProject;
}

const project = (clipObjects: Record<string, string>, rootCompositionId = 'root'): JoyProjectV1 =>
  ({
    rootCompositionId,
    pluginData: { 'joy.clipObjects': clipObjects },
  }) as unknown as JoyProjectV1;

describe('trackLayerOrder', () => {
  it('puts the track with the higher order in front, whatever its place in the array', () => {
    const tl = timeline([
      { order: 0, clips: [{ id: 'clip-photo' }] },
      { order: 2, clips: [{ id: 'clip-title' }] },
    ]);
    const order = trackLayerOrder(project({ 'clip-title': 'title', 'clip-photo': 'photo' }), tl);
    expect(order['title']).toBeGreaterThan(order['photo']!);
    // Reordering rows changes `order`, not the array: the picture goes in front.
    const swapped = timeline([
      { order: 2, clips: [{ id: 'clip-photo' }] },
      { order: 0, clips: [{ id: 'clip-title' }] },
    ]);
    const after = trackLayerOrder(
      project({ 'clip-title': 'title', 'clip-photo': 'photo' }),
      swapped,
    );
    expect(after['photo']).toBeGreaterThan(after['title']!);
  });

  it('keeps every placed object above the video layer and skips clips with no object', () => {
    const tl = timeline([{ order: 0, clips: [{ id: 'clip-a' }, { id: 'clip-plain' }] }]);
    const order = trackLayerOrder(project({ 'clip-a': 'a' }), tl);
    expect(order['a']).toBeGreaterThanOrEqual(1);
    expect(Object.keys(order)).toEqual(['a']);
  });

  it('uses the clip that plays now when two clips share an object', () => {
    const tl = timeline([
      { order: 0, clips: [{ id: 'first', startUs: 0, durationUs: 1_000_000 }] },
      { order: 3, clips: [{ id: 'second', startUs: 2_000_000, durationUs: 1_000_000 }] },
    ]);
    const objects = project({ first: 'shared', second: 'shared' });
    expect(trackLayerOrder(objects, tl, 500_000)['shared']).toBe(1);
    expect(trackLayerOrder(objects, tl, 2_500_000)['shared']).toBe(4);
    expect(trackLayerOrder(objects, tl, 1_500_000)).toEqual({});
  });

  it('reads only the root composition and tolerates a project without bindings', () => {
    const nested = timeline([{ order: 5, clips: [{ id: 'child' }] }], 'merged');
    expect(trackLayerOrder(project({ child: 'x' }, 'root'), nested)['x']).toBe(6);
    expect(trackLayerOrder({} as unknown as JoyProjectV1, timeline([]))).toEqual({});
  });
});
