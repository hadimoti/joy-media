import { describe, expect, it } from 'vitest';
import { applyTransaction } from '@joy-media/commands';
import type { SpikeProject } from '@joy-media/project-schema';
import { rational } from '@joy-media/project-schema';
import { trimCommand } from '@joy-media/timeline-engine';
import type { JoyCodeAssetDescriptor } from './joy-code-asset-descriptors.js';
import { buildTimelineClipMoveTransaction } from './timeline-clip-interaction.js';
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
          {
            id: 'audio',
            kind: 'video',
            family: 'audio',
            order: 1,
            enabled: true,
            locked: false,
            clips: [],
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
      registeredAssets: [
        descriptor('asset-a', 'video'),
        descriptor('asset-b', 'video'),
        descriptor('asset-c', 'image'),
      ],
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
      registeredAssets: [descriptor('asset-a', 'video')],
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

  it('uses the exact manual trim and same-track move command factories', () => {
    const trim = compileJoyCodeTimelineOperations({
      planId: 'manual-trim',
      project: projectFixture(),
      registeredAssets: [],
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
      ],
    });
    expect(trim).toMatchObject({ ok: true });
    if (!trim.ok) return;
    expect(trim.commands).toEqual([
      trimCommand('root', 'video', 'clip-a', 'start', 100_000),
      trimCommand('root', 'video', 'clip-a', 'end', 1_500_000),
    ]);

    const base = projectFixture();
    const track = base.compositions.root!.tracks.find((candidate) => candidate.id === 'video')!;
    const clip = track.clips.find((candidate) => candidate.id === 'clip-a')!;
    const manualMove = buildTimelineClipMoveTransaction({
      compositionId: 'root',
      sourceTrackId: 'video',
      targetTrackId: 'video',
      clip,
      targetClips: track.clips,
      newStartUs: 4_000_000,
    });
    expect(manualMove?.commands).toHaveLength(1);
    const move = compileJoyCodeTimelineOperations({
      planId: 'manual-move',
      project: base,
      registeredAssets: [],
      operations: [
        {
          id: 'move',
          dependsOn: [],
          kind: 'timeline.moveClip',
          compositionId: 'root',
          sourceTrackId: 'video',
          targetTrackId: 'video',
          clipId: 'clip-a',
          newStartUs: 4_000_000,
        },
      ],
    });
    expect(move).toMatchObject({ ok: true });
    if (!move.ok) return;
    expect(move.commands).toEqual(manualMove?.commands);
  });

  it('fails closed for malformed, no-op, locked, cross-project, overlapping, and cross-track edits', () => {
    const base = projectFixture();
    const compile = (operation: unknown, project = base) =>
      compileJoyCodeTimelineOperations({
        planId: 'fail-closed',
        project,
        registeredAssets: [],
        operations: [operation as never],
      });

    expect(
      compile({
        id: 'no-op-trim',
        dependsOn: [],
        kind: 'timeline.trimClip',
        compositionId: 'root',
        trackId: 'video',
        clipId: 'clip-a',
        newStartUs: 0,
        newEndUs: 2_000_000,
      }),
    ).toMatchObject({ ok: false, error: { code: 'JOY_CODE_TIMELINE_COMMAND_REJECTED' } });

    expect(
      compile({
        id: 'no-op-move',
        dependsOn: [],
        kind: 'timeline.moveClip',
        compositionId: 'root',
        sourceTrackId: 'video',
        targetTrackId: 'video',
        clipId: 'clip-a',
        newStartUs: 0,
      }),
    ).toMatchObject({ ok: false, error: { code: 'JOY_CODE_TIMELINE_COMMAND_REJECTED' } });

    expect(
      compile({
        id: 'malformed',
        dependsOn: [],
        kind: 'timeline.trimClip',
        compositionId: 'root',
        trackId: 'video',
        clipId: 'clip-a',
        newStartUs: Number.NaN,
        newEndUs: 1_500_000,
      }),
    ).toMatchObject({ ok: false, error: { code: 'JOY_CODE_TIMELINE_COMMAND_REJECTED' } });

    expect(
      compile({
        id: 'cross-project',
        dependsOn: [],
        kind: 'timeline.trimClip',
        compositionId: 'other-project-root',
        trackId: 'video',
        clipId: 'clip-a',
        newStartUs: 100_000,
        newEndUs: 1_500_000,
      }),
    ).toMatchObject({ ok: false, error: { code: 'JOY_CODE_TIMELINE_COMMAND_REJECTED' } });

    expect(
      compile({
        id: 'overlap',
        dependsOn: [],
        kind: 'timeline.moveClip',
        compositionId: 'root',
        sourceTrackId: 'video',
        targetTrackId: 'video',
        clipId: 'clip-a',
        newStartUs: 1_000_000,
      }),
    ).toMatchObject({ ok: false, error: { code: 'JOY_CODE_TIMELINE_COMMAND_REJECTED' } });

    expect(
      compile({
        id: 'cross-track',
        dependsOn: [],
        kind: 'timeline.moveClip',
        compositionId: 'root',
        sourceTrackId: 'video',
        targetTrackId: 'audio',
        clipId: 'clip-a',
        newStartUs: 4_000_000,
      }),
    ).toMatchObject({ ok: false, error: { code: 'JOY_CODE_TIMELINE_COMMAND_REJECTED' } });

    const locked: SpikeProject = {
      ...base,
      compositions: {
        ...base.compositions,
        root: {
          ...base.compositions.root!,
          tracks: base.compositions.root!.tracks.map((track) =>
            track.id === 'video' ? { ...track, locked: true } : track,
          ),
        },
      },
    };
    expect(
      compile(
        {
          id: 'locked',
          dependsOn: [],
          kind: 'timeline.trimClip',
          compositionId: 'root',
          trackId: 'video',
          clipId: 'clip-a',
          newStartUs: 100_000,
          newEndUs: 1_500_000,
        },
        locked,
      ),
    ).toMatchObject({ ok: false, error: { code: 'JOY_CODE_TIMELINE_COMMAND_REJECTED' } });
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
      registeredAssets: [descriptor('asset-a', 'video')],
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

  it('places a trusted audio descriptor only on an audio lane', () => {
    const result = compileJoyCodeTimelineOperations({
      planId: 'plan-audio',
      project: projectFixture(),
      registeredAssets: [descriptor('voice-over', 'audio')],
      operations: [
        {
          id: 'insert-voice',
          dependsOn: [],
          kind: 'timeline.insertExistingAsset',
          compositionId: 'root',
          targetTrackId: 'audio',
          assetId: 'voice-over',
          startUs: 0,
          durationUs: 1_000_000,
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.commands[0]).toMatchObject({
      type: 'timeline.insertClip',
      payload: {
        trackId: 'audio',
        expectedFamily: 'audio',
        clip: { assetId: 'voice-over' },
      },
    });
    const applied = applyTransaction(projectFixture(), {
      label: 'Insert trusted audio',
      commands: result.commands,
    }).project;
    expect(
      applied.compositions.root!.tracks.find((track) => track.id === 'audio')?.clips,
    ).toMatchObject([{ assetId: 'voice-over' }]);
  });

  it('rejects a trusted audio descriptor on a visual lane before command creation', () => {
    const result = compileJoyCodeTimelineOperations({
      planId: 'plan-audio-on-visual',
      project: projectFixture(),
      registeredAssets: [descriptor('voice-over', 'audio')],
      operations: [
        {
          id: 'bad-voice',
          dependsOn: [],
          kind: 'timeline.insertExistingAsset',
          compositionId: 'root',
          targetTrackId: 'video',
          assetId: 'voice-over',
          startUs: 0,
          durationUs: 1_000_000,
        },
      ],
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'JOY_CODE_TIMELINE_INCOMPATIBLE_TRACK', operationId: 'bad-voice' },
    });
  });

  it('accepts trusted image and video descriptors on a visual lane', () => {
    const result = compileJoyCodeTimelineOperations({
      planId: 'plan-visual-media',
      project: projectFixture(),
      registeredAssets: [descriptor('poster', 'image'), descriptor('footage', 'video')],
      operations: [
        {
          id: 'insert-poster',
          dependsOn: [],
          kind: 'timeline.insertExistingAsset',
          compositionId: 'root',
          targetTrackId: 'video',
          assetId: 'poster',
          startUs: 4_000_000,
          durationUs: 500_000,
        },
        {
          id: 'insert-footage',
          dependsOn: ['insert-poster'],
          kind: 'timeline.insertExistingAsset',
          compositionId: 'root',
          targetTrackId: 'video',
          assetId: 'footage',
          startUs: 4_500_000,
          durationUs: 500_000,
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'timeline.insertClip',
          payload: expect.objectContaining({
            expectedFamily: 'visual',
            clip: expect.objectContaining({ assetId: 'poster' }),
          }),
        }),
        expect.objectContaining({
          type: 'timeline.insertClip',
          payload: expect.objectContaining({
            expectedFamily: 'visual',
            clip: expect.objectContaining({ assetId: 'footage' }),
          }),
        }),
      ]),
    );
  });

  it.each(['lut', 'other'] as const)(
    'rejects unsupported %s descriptors instead of coercing them into a visual clip',
    (kind) => {
      const result = compileJoyCodeTimelineOperations({
        planId: `plan-${kind}`,
        project: projectFixture(),
        registeredAssets: [descriptor(`${kind}-asset`, kind)],
        operations: [
          {
            id: 'unsupported',
            dependsOn: [],
            kind: 'timeline.insertExistingAsset',
            compositionId: 'root',
            targetTrackId: 'video',
            assetId: `${kind}-asset`,
            startUs: 4_000_000,
            durationUs: 500_000,
          },
        ],
      });
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'JOY_CODE_TIMELINE_ASSET_UNSUPPORTED', operationId: 'unsupported' },
      });
    },
  );
});

function descriptor(id: string, kind: JoyCodeAssetDescriptor['kind']): JoyCodeAssetDescriptor {
  const mimeType = kind === 'audio' ? 'audio/wav' : kind === 'image' ? 'image/png' : 'video/mp4';
  return { id, kind, descriptor: { mimeType } };
}
