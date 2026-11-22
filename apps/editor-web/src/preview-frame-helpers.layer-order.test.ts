import { describe, expect, it } from 'vitest';
import type { JoyProjectV1, SpikeProject } from '@joy-media/project-schema';
import { trackLayerOrder } from './preview-frame-helpers.js';

const clip = (id: string) => ({ id, startUs: 0, durationUs: 1_000_000 });

function timeline(trackClipIds: readonly (readonly string[])[]): SpikeProject {
  return {
    compositions: {
      root: {
        tracks: trackClipIds.map((ids, index) => ({ id: `t${index}`, clips: ids.map(clip) })),
      },
    },
  } as unknown as SpikeProject;
}

const project = (clipObjects: Record<string, string>): JoyProjectV1 =>
  ({ pluginData: { 'joy.clipObjects': clipObjects } }) as unknown as JoyProjectV1;

describe('trackLayerOrder', () => {
  it('puts the top row in front', () => {
    const order = trackLayerOrder(
      project({ 'clip-title': 'title', 'clip-photo': 'photo' }),
      timeline([['clip-title'], ['clip-photo']]),
    );
    expect(order['title']).toBeGreaterThan(order['photo']!);
  });

  it('follows the rows when they are reordered', () => {
    const order = trackLayerOrder(
      project({ 'clip-title': 'title', 'clip-photo': 'photo' }),
      timeline([['clip-photo'], ['clip-title']]),
    );
    expect(order['photo']).toBeGreaterThan(order['title']!);
  });

  it('keeps every placed object above the video layer and skips clips with no object', () => {
    const order = trackLayerOrder(project({ 'clip-a': 'a' }), timeline([['clip-a', 'clip-plain']]));
    expect(order['a']).toBeGreaterThanOrEqual(1);
    expect(Object.keys(order)).toEqual(['a']);
  });

  it('returns nothing for a project without clip bindings', () => {
    expect(trackLayerOrder({} as unknown as JoyProjectV1, timeline([['c']]))).toEqual({});
  });
});
