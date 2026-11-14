import { describe, expect, it } from 'vitest';
import type { JoyProjectV1 } from '@joy-media/project-schema';
import { computeClipEffectFlags } from './timeline-clip-effect-flags.js';

const transform = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 };

function project(partial: Record<string, unknown>): JoyProjectV1 {
  return {
    pluginData: { 'joy.clipObjects': { 'clip-a': 'obj-a', 'clip-b': 'obj-b', 'clip-c': 'obj-c' } },
    visualObjects: {
      'obj-a': { id: 'obj-a', kind: 'null', transform },
      'obj-b': { id: 'obj-b', kind: 'null', transform },
      'obj-c': { id: 'obj-c', kind: 'null', transform },
    },
    transitions: [],
    ...partial,
  } as unknown as JoyProjectV1;
}

describe('computeClipEffectFlags', () => {
  it('leaves a plain clip out', () => {
    expect(computeClipEffectFlags(project({}))['clip-a']).toBeUndefined();
  });

  it('flags a clip whose own object has an effect', () => {
    const flags = computeClipEffectFlags(
      project({
        visualObjects: {
          'obj-a': {
            id: 'obj-a',
            kind: 'null',
            transform,
            effects: [{ id: 'e1', effectId: 'sepia' }],
          },
          'obj-b': { id: 'obj-b', kind: 'null', transform },
          'obj-c': { id: 'obj-c', kind: 'null', transform },
        },
      }),
    );
    expect(flags['clip-a']).toEqual({ effects: true, transition: false });
    expect(flags['clip-b']).toBeUndefined();
  });

  it('flags the media clip when a filter layer is parented to its object', () => {
    const flags = computeClipEffectFlags(
      project({
        visualObjects: {
          'obj-a': { id: 'obj-a', kind: 'null', transform },
          'obj-b': { id: 'obj-b', kind: 'null', transform },
          'obj-c': { id: 'obj-c', kind: 'null', transform },
          layer: {
            id: 'layer',
            kind: 'null',
            transform,
            parentId: 'obj-b',
            effects: [{ id: 'e2', effectId: 'gaussian-blur' }],
          },
        },
      }),
    );
    expect(flags['clip-b']).toEqual({ effects: true, transition: false });
  });

  it('flags both clips of a transition', () => {
    const flags = computeClipEffectFlags(
      project({
        transitions: [
          {
            id: 't1',
            trackId: 'v1',
            leftClipId: 'clip-a',
            rightClipId: 'clip-b',
            type: 'gl:fade',
            durationUs: 500_000,
          },
        ],
      }),
    );
    expect(flags['clip-a']).toEqual({ effects: false, transition: true });
    expect(flags['clip-b']).toEqual({ effects: false, transition: true });
    expect(flags['clip-c']).toBeUndefined();
  });
});
