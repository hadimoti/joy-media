import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JoyProjectV1 } from '@joy-media/project-schema';
import { CliJoyAgentToolBridge } from './bridge.js';
import { resolveFfmpegExecutable } from '../render/ffmpeg-run.js';
import { resolveTextFont } from '../render/text-font.js';
import { createTextClip } from '../render/text-clip.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { shell: false }).status === 0;

function projectWithTracks(): JoyProjectV1 {
  return {
    schemaVersion: 1,
    id: 'project-1',
    title: 'Move test',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    rootCompositionId: 'root',
    settings: { defaultLocale: 'en' },
    compositions: {
      root: {
        id: 'root',
        name: 'Root',
        width: 1920,
        height: 1080,
        pixelAspectRatio: { num: 1, den: 1 },
        frameRate: { num: 30, den: 1 },
        durationUs: 10_000_000,
        background: '#000000',
        tracks: [
          {
            id: 'video-1',
            kind: 'video',
            family: 'visual',
            name: 'Video 1',
            order: 0,
            enabled: true,
            locked: false,
            clips: [
              {
                id: 'early',
                kind: 'video',
                assetId: 'asset',
                startUs: 0,
                durationUs: 1_000_000,
                sourceInUs: 0,
              },
              {
                id: 'moving',
                kind: 'video',
                assetId: 'asset',
                startUs: 2_000_000,
                durationUs: 1_000_000,
                sourceInUs: 0,
              },
            ],
          },
          {
            id: 'video-2',
            kind: 'video',
            family: 'visual',
            name: 'Video 2',
            order: 1,
            enabled: true,
            locked: false,
            clips: [],
          },
        ],
      },
    },
    assets: {},
    variables: {},
    markers: [],
    visualObjects: {},
    captionDocuments: {},
    pluginData: {},
  } as JoyProjectV1;
}

describe('CLI Joy Agent bridge timeline operations', () => {
  it('counts spans covered only by captions as black in the placement summary', async () => {
    const baseProject = projectWithTracks();
    const root = baseProject.compositions.root!;
    const text = createTextClip({
      id: 'caption-only',
      text: 'Text over black',
      startUs: 4_000_000,
      durationUs: 2_000_000,
    });
    const project: JoyProjectV1 = {
      ...baseProject,
      captionDocuments: { [text.document.id]: text.document },
      compositions: {
        ...baseProject.compositions,
        root: {
          ...root,
          tracks: [
            ...root.tracks,
            {
              id: 'captions',
              kind: 'caption',
              family: 'visual',
              name: 'Captions',
              order: 2,
              enabled: true,
              locked: false,
              clips: [text.clip],
            },
          ],
        },
      },
    };
    const bridge = new CliJoyAgentToolBridge(project, 1);
    await bridge.proposeTimelineOperations({ operations: [] });
    const result = bridge.applyStaged();
    expect(result.placementSummary.blackRegions).toContainEqual({
      startUs: 3_000_000,
      endUs: 6_000_000,
    });
  });

  it('uses the renderer ffmpeg resolver configured by JOY_FFMPEG', () => {
    const previous = process.env.JOY_FFMPEG;
    process.env.JOY_FFMPEG = 'custom-ffmpeg-test';
    try {
      expect(resolveFfmpegExecutable()).toBe('custom-ffmpeg-test');
    } finally {
      if (previous === undefined) delete process.env.JOY_FFMPEG;
      else process.env.JOY_FFMPEG = previous;
    }
  });

  it.skipIf(!hasFfmpeg)(
    'reads a bounded JPEG frame from the composited local timeline',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'joy-agent-frame-'));
      try {
        const mediaPath = join(dir, 'fixture.mp4');
        const generated = spawnSync(
          'ffmpeg',
          [
            '-y',
            '-f',
            'lavfi',
            '-i',
            'color=c=red:s=160x90:r=25:d=1',
            '-c:v',
            'libx264',
            '-pix_fmt',
            'yuv420p',
            mediaPath,
          ],
          { shell: false, stdio: 'ignore' },
        );
        expect(generated.status).toBe(0);
        const baseProject = projectWithTracks();
        const root = baseProject.compositions.root!;
        const text = createTextClip({
          id: 'frame-caption',
          text: "it's 50%: a,b;[c] x'\\:textfile=/tmp/dt/secret.txt\\:y='5",
          startUs: 0,
          durationUs: 1_000_000,
          size: 24,
        });
        const project: JoyProjectV1 = {
          ...baseProject,
          captionDocuments: { [text.document.id]: text.document },
          compositions: {
            ...baseProject.compositions,
            root: {
              ...root,
              width: 160,
              height: 90,
              durationUs: 1_000_000,
              tracks: [
                ...root.tracks.map((track, index) =>
                  index === 0
                    ? {
                        ...track,
                        clips: [
                          {
                            id: 'frame-clip',
                            kind: 'video' as const,
                            assetId: 'frame-asset',
                            startUs: 0,
                            durationUs: 1_000_000,
                            sourceInUs: 0,
                          },
                        ],
                      }
                    : track,
                ),
                {
                  id: 'caption-track',
                  kind: 'caption',
                  family: 'visual',
                  name: 'Captions',
                  order: 2,
                  enabled: true,
                  locked: false,
                  clips: [text.clip],
                },
              ],
            },
          },
          assets: {
            ...baseProject.assets,
            'frame-asset': {
              id: 'frame-asset',
              kind: 'video',
              displayName: 'fixture',
              localSource: { path: mediaPath },
            },
          },
        };
        const result = await new CliJoyAgentToolBridge(project, 1).readFrame({
          atUs: 500_000,
          maxEdge: 80,
        });
        expect(result).toMatchObject({ mediaType: 'image/jpeg', width: 80, height: 45 });
        if ('base64' in result) {
          expect(Buffer.from(result.base64, 'base64').byteLength).toBeGreaterThan(800);
          expect(Buffer.from(result.base64, 'base64').subarray(0, 2)).toEqual(
            Buffer.from([0xff, 0xd8]),
          );
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('moves a clip between tracks and keeps each track sorted by timeline start', async () => {
    const bridge = new CliJoyAgentToolBridge(projectWithTracks(), 1);
    await bridge.proposeTimelineOperations({
      operations: [
        {
          kind: 'move',
          id: 'move-op',
          clipId: 'moving',
          trackId: 'video-2',
          startUs: 5_000_000,
          dependsOn: [],
        },
      ],
    });

    const { updatedProject, appliedCount, errors } = bridge.applyStaged();
    const tracks = updatedProject.compositions.root!.tracks;
    expect(errors).toEqual([]);
    expect(appliedCount).toBe(1);
    expect(tracks[0]!.clips.map((clip) => clip.id)).toEqual(['early']);
    expect(tracks[1]!.clips.map((clip) => [clip.id, clip.startUs])).toEqual([
      ['moving', 5_000_000],
    ]);
  });

  it('rejects a missing target without losing the source clip', async () => {
    const bridge = new CliJoyAgentToolBridge(projectWithTracks(), 1);
    await bridge.proposeTimelineOperations({
      operations: [
        {
          kind: 'move',
          id: 'move-op',
          clipId: 'moving',
          trackId: 'missing',
          startUs: 5_000_000,
          dependsOn: [],
        },
      ],
    });

    const { updatedProject, appliedCount, errors } = bridge.applyStaged();
    expect(appliedCount).toBe(0);
    expect(errors).toContain('Target track missing not found');
    expect(updatedProject.compositions.root!.tracks[0]!.clips.map((clip) => clip.id)).toEqual([
      'early',
      'moving',
    ]);
  });

  it('trims video source position using playback rate and reverse semantics', async () => {
    const project = projectWithTracks();
    const clips = project.compositions.root!.tracks[0]!.clips as unknown as Array<
      Record<string, unknown>
    >;
    clips[1] = {
      ...clips[1],
      startUs: 2_000_000,
      durationUs: 4_000_000,
      sourceInUs: 1_000_000,
      playbackRate: 2,
    };
    const bridge = new CliJoyAgentToolBridge(project, 1);
    await bridge.proposeTimelineOperations({
      operations: [
        {
          kind: 'trim',
          id: 'trim-op',
          clipId: 'moving',
          startUs: 3_000_000,
          endUs: 5_000_000,
          dependsOn: [],
        },
      ],
    });
    const result = bridge.applyStaged();
    const clip = result.updatedProject.compositions.root!.tracks[0]!.clips[1]!;
    expect(clip).toMatchObject({
      startUs: 3_000_000,
      durationUs: 2_000_000,
      sourceInUs: 3_000_000,
    });
    expect(result.placementSummary.clips.find((item) => item.clipId === 'moving')).toMatchObject({
      trackId: 'video-1',
      track: 'Video 1',
      startUs: 3_000_000,
      endUs: 5_000_000,
      sourceInUs: 3_000_000,
      sourceOutUs: 7_000_000,
    });
    expect(result.placementSummary.gaps).toContainEqual({
      trackId: 'video-1',
      startUs: 1_000_000,
      endUs: 3_000_000,
    });
    expect(result.placementSummary.blackRegions).toContainEqual({
      startUs: 1_000_000,
      endUs: 3_000_000,
    });
  });

  it('splits with a source offset and deterministic operation id', async () => {
    const bridge = new CliJoyAgentToolBridge(projectWithTracks(), 1);
    await bridge.proposeTimelineOperations({
      operations: [
        { kind: 'split', id: 'split-op', clipId: 'moving', atUs: 2_500_000, dependsOn: [] },
      ],
    });
    const result = bridge.applyStaged();
    const clips = result.updatedProject.compositions.root!.tracks[0]!.clips;
    expect(clips.map((clip) => [clip.id, clip.startUs, clip.durationUs])).toEqual([
      ['early', 0, 1_000_000],
      ['moving', 2_000_000, 500_000],
      ['moving-split-split-op', 2_500_000, 500_000],
    ]);
    expect(clips[2]).toMatchObject({ sourceInUs: 500_000 });
  });

  it('does not claim text/effect operations that the renderer cannot display', async () => {
    const project = {
      ...projectWithTracks(),
      visualObjects: {
        title: {
          id: 'title',
          kind: 'text',
          text: 'Old',
          transform: {
            x: 0,
            y: 0,
            scaleX: 1,
            scaleY: 1,
            rotationDeg: 0,
            opacity: 1,
            crop: { left: 0, top: 0, right: 0, bottom: 0 },
          },
        },
      },
    } as JoyProjectV1;
    const bridge = new CliJoyAgentToolBridge(project, 1);
    await bridge.proposeDocumentOperations({
      operations: [
        { kind: 'set-text', id: 'text-op', objectId: 'title', text: 'New title', dependsOn: [] },
        {
          kind: 'set-property',
          id: 'prop-op',
          objectId: 'title',
          property: 'opacity',
          value: 0.5,
          dependsOn: [],
        },
        {
          kind: 'set-property',
          id: 'bad-prop-op',
          objectId: 'title',
          property: 'unlisted',
          value: 1,
          dependsOn: [],
        },
        { kind: 'add-effect', id: 'effect-op', objectId: 'title', effectId: 'blur', dependsOn: [] },
        { kind: 'set-text', id: 'missing-op', objectId: 'missing', text: 'ignored', dependsOn: [] },
      ],
    });
    const result = bridge.applyStaged();
    expect(result.appliedCount).toBe(0);
    expect(result.errors.some((error) => error.startsWith('unsupported: set-text'))).toBe(true);
    expect(
      result.errors.some((error) => error.startsWith('unsupported: text property opacity')),
    ).toBe(true);
    expect(
      result.errors.some((error) => error.startsWith('unsupported: text property unlisted')),
    ).toBe(true);
    expect(result.errors).toContain('unsupported: effect blur is not rendered by ffmpeg.');
    expect(result.errors).toContain('unsupported: set-text for missing is not rendered by ffmpeg.');
    expect(result.updatedProject.visualObjects.title).toMatchObject({
      text: 'Old',
      transform: { opacity: 1 },
    });
  });

  it.skipIf(!resolveTextFont())('stores create-text as a valid timed caption clip', async () => {
    const project = projectWithTracks();
    const bridge = new CliJoyAgentToolBridge(project, 1);
    await bridge.proposeDocumentOperations({
      operations: [
        {
          kind: 'create-text',
          id: 'headline',
          text: 'Hello JOY',
          startUs: 500_000,
          durationUs: 2_000_000,
          size: 48,
          color: '#ffcc00',
          dependsOn: [],
        },
      ],
    });
    const result = bridge.applyStaged();
    expect(result.appliedCount).toBe(1);
    expect(result.errors).toEqual([]);
    expect(result.updatedProject.captionDocuments.headline?.words['headline-word']?.text).toBe(
      'Hello JOY',
    );
    expect(
      result.updatedProject.compositions.root!.tracks.flatMap((track) => track.clips),
    ).toContainEqual(
      expect.objectContaining({ kind: 'caption', startUs: 500_000, durationUs: 2_000_000 }),
    );
  });

  it('reports whether the plan will wait for approval or auto-apply', async () => {
    const staged = new CliJoyAgentToolBridge(projectWithTracks(), 1);
    const automatic = new CliJoyAgentToolBridge(projectWithTracks(), 1, undefined, true);
    await expect(staged.submitPlan()).resolves.toMatchObject({
      awaitingApproval: true,
      willApplyOnFinish: false,
    });
    await expect(automatic.submitPlan()).resolves.toMatchObject({
      awaitingApproval: false,
      willApplyOnFinish: true,
    });
  });

  it('returns the resulting placement to the agent when auto-apply is submitted', async () => {
    const automatic = new CliJoyAgentToolBridge(projectWithTracks(), 1, undefined, true);
    await automatic.proposeTimelineOperations({
      operations: [
        {
          kind: 'move',
          id: 'move-op',
          clipId: 'moving',
          trackId: 'video-1',
          startUs: 4_000_000,
          dependsOn: [],
        },
      ],
    });
    const submit = await automatic.submitPlan();
    const submitted = submit as {
      applied: boolean;
      placementSummary: { clips: Array<{ clipId: string; startUs: number; endUs: number }> };
    };
    expect(submitted.applied).toBe(true);
    expect(submitted.placementSummary.clips.find((clip) => clip.clipId === 'moving')).toMatchObject(
      {
        startUs: 4_000_000,
        endUs: 5_000_000,
      },
    );
    const applied = automatic.applyStaged();
    expect(applied.appliedCount).toBe(1);
    expect(applied.placementSummary.clips.find((clip) => clip.clipId === 'moving')?.startUs).toBe(
      4_000_000,
    );
  });

  it('keeps the previous project when applying operations makes it invalid', async () => {
    const project = {
      ...projectWithTracks(),
      visualObjects: {
        title: {
          id: 'title',
          kind: 'text',
          text: 'Title',
          transform: {
            x: 0,
            y: 0,
            scaleX: 1,
            scaleY: 1,
            rotationDeg: 0,
            opacity: 1,
            crop: { left: 0, top: 0, right: 0, bottom: 0 },
          },
        },
      },
    } as JoyProjectV1;
    const bridge = new CliJoyAgentToolBridge(project, 1);
    await bridge.proposeDocumentOperations({
      operations: [
        {
          kind: 'set-property',
          id: 'invalid-opacity',
          objectId: 'title',
          property: 'opacity',
          value: -1,
          dependsOn: [],
        },
      ],
    });
    const result = bridge.applyStaged();
    expect(result.errors.some((error) => error.includes('opacity'))).toBe(true);
    expect(result.updatedProject.visualObjects.title).toMatchObject({
      transform: { opacity: 1 },
    });
  });
});
