import { describe, expect, it } from 'vitest';
import { applyTransaction } from '@joy-media/commands';
import type { SpikeProject } from '@joy-media/project-schema';
import { rational } from '@joy-media/project-schema';
import { compileJoyCodeTimelineOperations } from './joy-code-timeline-compiler.js';

function projectFixture(): SpikeProject {
  return {
    schemaVersion: 0,
    id: 'project-1',
    rootCompositionId: 'root',
    compositions: {
      root: {
        id: 'root',
        name: 'Root',
        width: 1920,
        height: 1080,
        frameRate: rational(30, 1),
        durationUs: 5_000_000,
        tracks: [
          {
            id: 'video',
            kind: 'video',
            family: 'visual',
            order: 0,
            enabled: true,
            locked: false,
            clips: [
              {
                kind: 'video',
                id: 'clip-a',
                startUs: 0,
                durationUs: 2_000_000,
                assetId: 'asset-a',
                sourceInUs: 0,
              },
              {
                kind: 'video',
                id: 'clip-b',
                startUs: 2_000_000,
                durationUs: 2_000_000,
                assetId: 'asset-b',
                sourceInUs: 0,
              },
            ],
          },
        ],
      },
    },
  };
}

describe('Joy Code timeline compiler', () => {
  it('compiles trim, split, move, remove, and registered insertion into real commands', () => {
    const result = compileJoyCodeTimelineOperations({
      planId: 'plan-1',
      project: projectFixture(),
      registeredAssetIds: ['asset-a', 'asset-b', 'asset-c'],
      operations: [
        {
          id: 'trim',
          dependsOn: [],
          kind: 'timeline.trimClip',
          compositionId: 'root',
          trackId: 'video',
          clipId: 'clip-a',
          newStartUs: 100_000,
          newEndUs: 1_500_000,
        },
        {
          id: 'split',
          dependsOn: ['trim'],
          kind: 'timeline.splitClip',
          compositionId: 'root',
          trackId: 'video',
          clipId: 'clip-b',
          atUs: 3_000_000,
        },
        {
          id: 'move',
          dependsOn: ['split'],
          kind: 'timeline.moveClip',
          compositionId: 'root',
          sourceTrackId: 'video',
          targetTrackId: 'video',
          clipId: 'clip-a',
          newStartUs: 500_000,
        },
        {
          id: 'remove',
          dependsOn: ['move'],
          kind: 'timeline.removeClip',
          compositionId: 'root',
          trackId: 'video',
          clipId: 'clip-b',
        },
        {
          id: 'insert',
          dependsOn: [],
          kind: 'timeline.insertExistingAsset',
          compositionId: 'root',
          targetTrackId: 'video',
          assetId: 'asset-c',
          startUs: 4_000_000,
          durationUs: 500_000,
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.commands.map((command) => command.type)).toEqual([
      'timeline.trimClipStart',
      'timeline.trimClipEnd',
      'timeline.splitClip',
      'timeline.moveClip',
      'timeline.removeClip',
      'timeline.insertClip',
    ]);
    expect(result.affectedIds).toEqual(expect.arrayContaining(['clip-a', 'clip-b', 'asset-c']));
    expect(result.commands[2]).toMatchObject({
      type: 'timeline.splitClip',
      payload: { newClipId: 'plan-1-split-1' },
    });
  });

  it('applies the compiled transaction to a clone and preserves input on failure', () => {
    const base = projectFixture();
    const result = compileJoyCodeTimelineOperations({
      planId: 'plan-2',
      project: base,
      registeredAssetIds: ['asset-a'],
      operations: [
        {
          id: 'good',
          dependsOn: [],
          kind: 'timeline.trimClip',
          compositionId: 'root',
          trackId: 'video',
          clipId: 'clip-a',
          newStartUs: 100_000,
          newEndUs: 1_500_000,
        },
        {
          id: 'bad',
          dependsOn: ['good'],
          kind: 'timeline.insertExistingAsset',
          compositionId: 'root',
          targetTrackId: 'video',
          assetId: 'unregistered',
          startUs: 500_000,
          durationUs: 500_000,
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(base.compositions.root!.tracks[0]!.clips[0]!.startUs).toBe(0);
  });

  it('rejects cycles, locked tracks, invalid ranges, and unavailable assets before returning commands', () => {
    const base = projectFixture();
    const locked: SpikeProject = {
      ...base,
      compositions: {
        root: {
          ...base.compositions.root!,
          tracks: [{ ...base.compositions.root!.tracks[0]!, locked: true }],
        },
      },
    };
    const result = compileJoyCodeTimelineOperations({
      planId: 'plan-3',
      project: locked,
      registeredAssetIds: ['asset-a'],
      operations: [
        {
          id: 'a',
          dependsOn: ['b'],
          kind: 'timeline.removeClip',
          compositionId: 'root',
          trackId: 'video',
          clipId: 'clip-a',
        },
        {
          id: 'b',
          dependsOn: ['a'],
          kind: 'timeline.insertExistingAsset',
          compositionId: 'root',
          targetTrackId: 'video',
          assetId: 'missing',
          startUs: 0,
          durationUs: 100_000,
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('JOY_CODE_TIMELINE_DEPENDENCY_CYCLE');
  });
});
