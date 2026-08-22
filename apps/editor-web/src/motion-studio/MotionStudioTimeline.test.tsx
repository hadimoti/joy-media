import { describe, expect, it, vi } from 'vitest';
import type { MotionAnimation } from '@joy-media/motion-core';
import {
  copyMotionKeyframes,
  moveMotionKeyframes,
  pasteMotionKeyframes,
} from './MotionStudioTimeline.js';
import { buildMotionScenePlacementPlan } from './motionScenePlacement.js';

const animations: readonly MotionAnimation[] = [
  {
    property: 'transform.x',
    curve: {
      keyframes: [
        { id: 'x0', timeMs: 120, value: 0, easing: { kind: 'builtin', name: 'linear' } },
        { id: 'x1', timeMs: 1120, value: 100, easing: { kind: 'builtin', name: 'linear' } },
      ],
    },
  },
  {
    property: 'transform.y',
    curve: {
      keyframes: [{ id: 'y0', timeMs: 620, value: 20, easing: { kind: 'builtin', name: 'ease' } }],
    },
  },
];

describe('MotionStudioTimeline keyframe editing helpers', () => {
  it('moves multi-selected keyframes and snaps them to the requested grid', () => {
    const moved = moveMotionKeyframes(
      animations,
      [
        { property: 'transform.x', keyframeId: 'x0' },
        { property: 'transform.y', keyframeId: 'y0' },
      ],
      260,
      { durationMs: 2000, snapIntervalMs: 100 },
    );

    expect(moved[0]!.curve.keyframes.map((keyframe) => keyframe.timeMs)).toEqual([400, 1120]);
    expect(moved[1]!.curve.keyframes.map((keyframe) => keyframe.timeMs)).toEqual([900]);
  });

  it('copies a multi-property selection relative to the earliest keyframe and pastes with fresh ids', () => {
    vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce('new-x' as `${string}-${string}-${string}-${string}-${string}`)
      .mockReturnValueOnce('new-y' as `${string}-${string}-${string}-${string}-${string}`);

    const clipboard = copyMotionKeyframes(animations, [
      { property: 'transform.x', keyframeId: 'x0' },
      { property: 'transform.y', keyframeId: 'y0' },
    ]);
    expect(clipboard?.anchorTimeMs).toBe(120);

    const pasted = pasteMotionKeyframes(animations, clipboard!, 1000, {
      durationMs: 2000,
      snapIntervalMs: 50,
    });
    expect(pasted[0]!.curve.keyframes.map((keyframe) => [keyframe.id, keyframe.timeMs])).toEqual([
      ['x0', 120],
      ['new-x', 1000],
      ['x1', 1120],
    ]);
    expect(pasted[1]!.curve.keyframes.map((keyframe) => [keyframe.id, keyframe.timeMs])).toEqual([
      ['y0', 620],
      ['new-y', 1500],
    ]);
  });

  it('builds main-timeline placement for a published Motion Studio scene using opaque asset ids', () => {
    const plan = buildMotionScenePlacementPlan({
      nowMs: 1234,
      motionSceneId: 'motion-doc-1',
      selectedClipId: 'source',
      visualProject: {
        schemaVersion: 1,
        id: 'visual',
        title: 'Visual',
        createdAt: '2026-08-22T00:00:00.000Z',
        updatedAt: '2026-08-22T00:00:00.000Z',
        rootCompositionId: 'root',
        settings: { defaultLocale: 'en-US' },
        compositions: {},
        assets: {},
        variables: {},
        markers: [],
        visualObjects: {},
        captionDocuments: {},
        pluginData: {},
      },
      composition: {
        id: 'root',
        name: 'Root',
        width: 1080,
        height: 1920,
        frameRate: { num: 30, den: 1 },
        durationUs: 2_000_000,
        tracks: [
          {
            id: 'V1',
            kind: 'video',
            order: 0,
            enabled: true,
            clips: [
              {
                kind: 'video',
                id: 'source',
                assetId: 'real-source',
                startUs: 100_000,
                durationUs: 900_000,
                sourceInUs: 0,
              },
            ],
          },
        ],
      },
    });

    expect(plan?.visualTransaction.commands[0]).toMatchObject({
      type: 'motionScene.create',
      payload: { object: { kind: 'motion-scene', motionSceneId: 'motion-doc-1' } },
    });
    expect(plan?.timelineTransaction.commands.at(-1)).toMatchObject({
      type: 'timeline.insertClip',
      payload: {
        clip: {
          kind: 'video',
          assetId: 'motion-scene:motion-doc-1',
          startUs: 100_000,
          durationUs: 900_000,
        },
      },
    });
  });
});
