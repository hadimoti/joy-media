import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JoyProjectV1 } from '@joy-media/project-schema';
import { createJoyAgentTools } from '@joy-media/joy-agent-engine';
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

describe('CLI Joy Agent bridge through the engine tool set', () => {
  it('reads the project summary and selection from a real bridge instance', async () => {
    const bridge = new CliJoyAgentToolBridge(projectWithTracks(), 3);
    bridge.setSelection(['moving'], 2_500_000);
    const tools = createJoyAgentTools(bridge);
    const execute = (name: string) =>
      (tools[name] as unknown as { execute: (input: unknown) => Promise<unknown> }).execute({});

    await expect(execute('read_project_summary')).resolves.toMatchObject({
      projectId: 'project-1',
      revision: 3,
      clipCount: 2,
    });
    await expect(execute('read_selection')).resolves.toEqual({
      selectedClipIds: ['moving'],
      playheadUs: 2_500_000,
    });
    await expect(execute('read_style_catalog')).resolves.toMatchObject({
      looks: ['crt', 'bw', 'warm', 'cool'],
    });
  });
});

describe('CLI Joy Agent bridge timeline operations', () => {
  it('discards rejected proposal issues when a corrected proposal validates', async () => {
    const bridge = new CliJoyAgentToolBridge(projectWithTracks(), 1, undefined, true);
    const rejected = await bridge.proposeTimelineOperations({
      operations: [{ kind: 'remove', id: 'bad-remove', clipId: 'missing', dependsOn: [] }],
    });
    expect(rejected).toMatchObject({ accepted: false });
    expect(bridge.getReportedIssues()).toContain('Clip missing not found.');

    const corrected = await bridge.proposeTimelineOperations({
      operations: [
        {
          kind: 'move',
          id: 'move-ok',
          clipId: 'moving',
          trackId: 'video-2',
          startUs: 5_000_000,
          dependsOn: [],
        },
      ],
    });
    expect(corrected).toMatchObject({ accepted: true });
    expect(bridge.getReportedIssues()).toEqual([]);
    const result = bridge.applyStaged();
    expect(result.errors).toEqual([]);
    expect(result.appliedOperationIds).toContain('move-ok');
  });

  it('keeps issues until the same proposal type is corrected', async () => {
    const bridge = new CliJoyAgentToolBridge(projectWithTracks(), 1);
    await bridge.proposeTimelineOperations({
      operations: [{ kind: 'remove', id: 'bad-remove', clipId: 'missing', dependsOn: [] }],
    });
    await bridge.proposeDocumentOperations({
      operations: [
        {
          kind: 'create-text',
          id: 'title',
          text: 'Title',
          startUs: 0,
          durationUs: 1_000_000,
          dependsOn: [],
        },
      ],
    });
    expect(bridge.getReportedIssues()).toContain('Clip missing not found.');
    await bridge.proposeTimelineOperations({
      operations: [
        {
          kind: 'move',
          id: 'move-ok',
          clipId: 'moving',
          trackId: 'video-2',
          startUs: 5_000_000,
          dependsOn: [],
        },
      ],
    });
    expect(bridge.getReportedIssues()).toEqual([]);
  });

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
    expect(result.placementSummary.gaps.some((gap) => gap.trackId === 'video-2')).toBe(false);
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
          // The preview fixture is only 160×90. Use a visible editor-unit
          // multiplier so this test can distinguish rendered text from a
          // nearly blank JPEG while retaining the escaping payload.
          size: 8,
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

    const { updatedProject, appliedCount, appliedOperationIds, errors } = bridge.applyStaged();
    const tracks = updatedProject.compositions.root!.tracks;
    expect(errors).toEqual([]);
    expect(appliedCount).toBe(1);
    expect(appliedOperationIds).toEqual(['move-op']);
    expect(tracks[0]!.clips.map((clip) => clip.id)).toEqual(['early']);
    expect(tracks[1]!.clips.map((clip) => [clip.id, clip.startUs])).toEqual([
      ['moving', 5_000_000],
    ]);
  });

  it('rejects a missing target without losing the source clip', async () => {
    const bridge = new CliJoyAgentToolBridge(projectWithTracks(), 1);
    const proposal = (await bridge.proposeTimelineOperations({
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
    })) as { accepted: boolean; errors: string[] };

    const { updatedProject, appliedCount, errors } = bridge.applyStaged();
    expect(appliedCount).toBe(0);
    expect(proposal.accepted).toBe(false);
    expect(proposal.errors).toContain('Track missing not found.');
    expect(errors).toEqual([]);
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
          sourceInUs: 3_000_000,
          sourceOutUs: 7_000_000,
          timelineStartUs: 3_000_000,
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

  it('rejects an agent trim whose source range runs past the media end', async () => {
    const project = projectWithTracks();
    (project.assets as Record<string, unknown>).asset = {
      id: 'asset',
      kind: 'video',
      displayName: 'thirty.mp4',
      descriptor: { mimeType: 'video/mp4', durationUs: 30_000_000 },
    };
    const bridge = new CliJoyAgentToolBridge(project, 1);
    const rejected = await bridge.proposeTimelineOperations({
      operations: [
        {
          kind: 'trim',
          id: 'too-far',
          clipId: 'moving',
          sourceInUs: 25_000_000,
          sourceOutUs: 40_000_000,
          dependsOn: [],
        },
      ],
    });
    expect(rejected).toMatchObject({ accepted: false });
    expect(bridge.getReportedIssues().join(' ')).toContain('past the end of its media (30s)');
    expect(bridge.getStagedOperations().timelineOps).toEqual([]);
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
    const proposal = (await bridge.proposeDocumentOperations({
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
        {
          kind: 'add-effect',
          id: 'effect-op',
          objectId: 'missing-video',
          effectId: 'crt',
          dependsOn: [],
        },
        { kind: 'set-text', id: 'missing-op', objectId: 'missing', text: 'ignored', dependsOn: [] },
      ],
    })) as { accepted: boolean; errors: string[] };
    const result = bridge.applyStaged();
    expect(result.appliedCount).toBe(0);
    expect(proposal.accepted).toBe(false);
    expect(proposal.errors).toContain('set-text for title is not rendered by the CLI.');
    expect(proposal.errors).toContain('Text property opacity is not rendered by the CLI.');
    expect(proposal.errors).toContain('Text property unlisted is not rendered by the CLI.');
    expect(proposal.errors).toContain('Clip missing-video not found.');
    expect(proposal.errors).toContain('Object missing not found.');
    expect(result.errors).toEqual([]);
    expect(result.updatedProject.visualObjects.title).toMatchObject({
      text: 'Old',
      transform: { opacity: 1 },
    });
  });

  it('applies validated CLI looks through the agent operation path', async () => {
    const project = projectWithTracks();
    (project.compositions.root!.tracks[0]!.clips as unknown as unknown[]).push({
      id: 'look-target',
      kind: 'video',
      assetId: 'asset-default',
      startUs: 0,
      durationUs: 1_000_000,
      sourceInUs: 0,
    });
    const bridge = new CliJoyAgentToolBridge(project, 1);
    const proposal = await bridge.proposeDocumentOperations({
      operations: [
        {
          kind: 'add-effect',
          id: 'look-op',
          objectId: 'look-target',
          effectId: 'warm',
          intensity: 1,
          dependsOn: [],
        },
      ],
    });
    expect(proposal).toMatchObject({ accepted: true });
    const result = bridge.applyStaged();
    expect(result.appliedOperationIds).toEqual(['look-op']);
    expect(
      result.updatedProject.compositions.root!.tracks[0]!.clips.find(
        (clip) => clip.id === 'look-target',
      ),
    ).toMatchObject({
      look: { preset: 'warm', intensity: 1 },
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
          size: 1.5,
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

  it.skipIf(!resolveTextFont())(
    'reroutes create-text from a video track to a caption track',
    async () => {
      const project = projectWithTracks();
      const bridge = new CliJoyAgentToolBridge(project, 1);
      const proposal = await bridge.proposeDocumentOperations({
        operations: [
          {
            kind: 'create-text',
            id: 'video-target-text',
            trackId: 'video-1',
            text: 'Caption text',
            startUs: 0,
            durationUs: 1_000_000,
            dependsOn: [],
          },
        ],
      });
      expect(proposal).toMatchObject({
        accepted: true,
        notes: [expect.stringContaining('will be routed')],
      });
      const result = bridge.applyStaged();
      expect(result.errors).toEqual([]);
      expect(result.notes[0]).toContain('rerouted from video track video-1');
      expect(
        result.updatedProject.compositions.root!.tracks.find((track) => track.kind === 'video')
          ?.clips,
      ).toHaveLength(2);
      expect(
        result.updatedProject.compositions.root!.tracks.find((track) => track.kind === 'caption')
          ?.clips,
      ).toHaveLength(1);
    },
  );

  it('rejects create-text shorter than one project frame during planning', async () => {
    const bridge = new CliJoyAgentToolBridge(projectWithTracks(), 1);
    const proposal = (await bridge.proposeDocumentOperations({
      operations: [
        {
          kind: 'create-text',
          id: 'too-short',
          text: 'Tiny duration',
          startUs: 0,
          durationUs: 1,
          dependsOn: [],
        },
      ],
    })) as { accepted: boolean; errors: string[] };
    expect(proposal.accepted).toBe(false);
    expect(proposal.errors).toContain('Text too-short duration is shorter than one project frame.');
    expect(bridge.getStagedOperations().documentOps).toEqual([]);
  });

  it('reports whether the plan will wait for approval or auto-apply', async () => {
    const staged = new CliJoyAgentToolBridge(projectWithTracks(), 1);
    const automatic = new CliJoyAgentToolBridge(projectWithTracks(), 1, undefined, true);
    for (const bridge of [staged, automatic])
      await bridge.proposeTimelineOperations({
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
    await expect(staged.submitPlan()).resolves.toMatchObject({
      awaitingApproval: true,
      willApplyOnFinish: false,
    });
    await expect(automatic.submitPlan()).resolves.toMatchObject({
      awaitingApproval: false,
      willApplyOnFinish: true,
    });
  });

  it('refuses to stage a plan when every proposal was rejected', async () => {
    for (const autoApply of [false, true]) {
      const bridge = new CliJoyAgentToolBridge(projectWithTracks(), 1, undefined, autoApply);
      await bridge.proposeTimelineOperations({
        operations: [
          {
            kind: 'trim',
            id: 'bad-trim',
            clipId: 'track-v1-clip',
            sourceInUs: 0,
            sourceOutUs: 500_000,
            dependsOn: [],
          },
        ],
      });

      const result = await bridge.submitPlan({
        checklist: [{ kind: 'trim', clipId: 'track-v1-clip', sourceInUs: 0, sourceOutUs: 500_000 }],
      });

      expect(result).toMatchObject({ staged: false, willApplyOnFinish: false });
      const errors = (result as { validationErrors: string[] }).validationErrors;
      expect(errors[0]).toMatch(/No operations are staged/);
      expect(errors).toContain('Clip track-v1-clip not found.');
      expect(errors).toContain('Checklist references unknown clip track-v1-clip.');
      expect(bridge.hasSubmittedPlan()).toBe(false);
    }
  });

  it('flags checklist items that reference clips missing from the planned timeline', async () => {
    const bridge = new CliJoyAgentToolBridge(projectWithTracks(), 1, undefined, true);
    await bridge.proposeTimelineOperations({
      operations: [
        {
          kind: 'trim',
          id: 'good-trim',
          clipId: 'early',
          sourceInUs: 0,
          sourceOutUs: 500_000,
          dependsOn: [],
        },
      ],
    });

    const result = await bridge.submitPlan({
      checklist: [{ kind: 'look', clipId: 'ghost-clip', look: 'crt' }],
    });

    expect(result).toMatchObject({ staged: true });
    expect((result as { validationErrors: string[] }).validationErrors).toContain(
      'Checklist references unknown clip ghost-clip.',
    );
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
    expect(submitted.applied).toBe(false);
    expect(submitted.placementSummary.clips.find((clip) => clip.clipId === 'moving')?.startUs).toBe(
      4_000_000,
    );
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
    const proposal = (await bridge.proposeDocumentOperations({
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
    })) as { accepted: boolean; errors: string[] };
    const result = bridge.applyStaged();
    expect(proposal.accepted).toBe(false);
    expect(proposal.errors).toContain('Text property opacity is not rendered by the CLI.');
    expect(result.errors).toEqual([]);
    expect(result.updatedProject.visualObjects.title).toMatchObject({
      transform: { opacity: 1 },
    });
  });
});
