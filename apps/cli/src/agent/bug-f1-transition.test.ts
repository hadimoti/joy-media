// F1: transitions were advertised (read_style_catalog) but no operation could create one, the
// renderer skipped them, and a request for a crossfade that was silently dropped exited 0 with
// "Verified" (k2, d2, o2b).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { JoyProjectV1 } from '@joy-media/project-schema';
import { CliJoyAgentToolBridge } from './bridge.js';
import { buildFfmpegRenderPlan } from '../render/ffmpeg-plan.js';
import { fixtureProject, runScriptedAgent } from './scripted-agent.test-helper.js';

const prompt =
  'Make a 10-second edit: the first 5 seconds of the intro (source 0-5s) at timeline 0, then CLIP B source 2-7s placed right after it at 5s, with no gap. Add a crossfade transition between the two clips.';
const project = () =>
  fixtureProject({
    assets: { 'asset-a': 30_000_000, 'asset-b': 12_000_000 },
    clips: [
      { id: 'clip-a', assetId: 'asset-a', startUs: 0, durationUs: 30_000_000 },
      { id: 'clip-b', assetId: 'asset-b', startUs: 30_000_000, durationUs: 12_000_000 },
    ],
  });
const trims = {
  toolName: 'propose_timeline_operations',
  input: {
    operations: [
      {
        kind: 'trim',
        id: 't1',
        clipId: 'clip-a',
        sourceInUs: 0,
        sourceOutUs: 5_000_000,
        timelineStartUs: 0,
      },
      {
        kind: 'trim',
        id: 't2',
        clipId: 'clip-b',
        sourceInUs: 2_000_000,
        sourceOutUs: 7_000_000,
        timelineStartUs: 5_000_000,
      },
    ],
  },
};
const trimChecklist = [
  { kind: 'trim', clipId: 'clip-a', sourceInUs: 0, sourceOutUs: 5_000_000 },
  { kind: 'trim', clipId: 'clip-b', sourceInUs: 2_000_000, sourceOutUs: 7_000_000 },
];

describe('F1: transitions', () => {
  it('the style catalog only offers transitions the CLI can apply and render', async () => {
    const catalog = (await new CliJoyAgentToolBridge(project(), 1).readStyleCatalog()) as {
      transitions: string[];
    };
    expect(catalog.transitions).toEqual(['crossfade']);
  });

  it('a requested crossfade that was not applied fails the run (k2/d2/o2b)', async () => {
    const result = await runScriptedAgent({
      project: project(),
      prompt,
      steps: [
        trims,
        { toolName: 'submit_plan', input: { checklist: trimChecklist } },
        { text: 'Done.' },
      ],
    });
    expect(result.exitCode).toBe(1);
    expect(result.changed).toBe(false);
    expect(result.stderr).toMatch(/crossfade/);
  });

  it('add-transition (in the shape d2 sent) creates a crossfade between adjacent clips', async () => {
    const result = await runScriptedAgent({
      project: project(),
      prompt,
      steps: [
        trims,
        {
          toolName: 'propose_timeline_operations',
          input: {
            operations: [
              {
                id: 'x1',
                kind: 'transition',
                type: 'crossfade',
                clipIdA: 'clip-a',
                clipIdB: 'clip-b',
                durationUs: 1_000_000,
              },
            ],
          },
        },
        {
          toolName: 'submit_plan',
          input: {
            checklist: [
              ...trimChecklist,
              { kind: 'transition', leftClipId: 'clip-a', rightClipId: 'clip-b' },
            ],
          },
        },
        { text: 'Done.' },
      ],
    });
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(result.saved.transitions).toEqual([
      expect.objectContaining({
        trackId: 'track-v1',
        leftClipId: 'clip-a',
        rightClipId: 'clip-b',
        // Stored under the editor registry id (transition-shaders `dissolve` = crossfade).
        type: 'dissolve',
        durationUs: 1_000_000,
      }),
    ]);
  });

  it('rejects a transition between clips that do not touch', async () => {
    const gapped = fixtureProject({
      assets: { 'asset-a': 30_000_000, 'asset-b': 12_000_000 },
      clips: [
        { id: 'clip-a', assetId: 'asset-a', startUs: 0, durationUs: 5_000_000 },
        { id: 'clip-b', assetId: 'asset-b', startUs: 6_000_000, durationUs: 5_000_000 },
      ],
    });
    const bridge = new CliJoyAgentToolBridge(gapped, 1);
    const result = (await bridge.proposeTimelineOperations({
      operations: [
        {
          kind: 'add-transition',
          id: 'x',
          leftClipId: 'clip-a',
          rightClipId: 'clip-b',
          type: 'crossfade',
          durationUs: 1_000_000,
          dependsOn: [],
        },
      ] as never,
    })) as { accepted: boolean; errors?: string[] };
    expect(result.accepted).toBe(false);
    expect(result.errors?.join(' ')).toMatch(/adjacent|touch/);
  });

  it('the renderer draws the crossfade instead of skipping it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'joy-xfade-'));
    try {
      const a = join(dir, 'a.mp4');
      const b = join(dir, 'b.mp4');
      writeFileSync(a, 'placeholder');
      writeFileSync(b, 'placeholder');
      const base = project();
      const root = base.compositions[base.rootCompositionId]!;
      const withMedia = {
        ...base,
        assets: {
          'asset-a': { ...base.assets['asset-a']!, localSource: { path: a } },
          'asset-b': { ...base.assets['asset-b']!, localSource: { path: b } },
        },
        compositions: {
          ...base.compositions,
          root: {
            ...root,
            durationUs: 10_000_000,
            tracks: root.tracks.map((track) =>
              track.id === 'track-v1'
                ? {
                    ...track,
                    clips: [
                      { ...track.clips[0]!, startUs: 0, durationUs: 5_000_000, sourceInUs: 0 },
                      {
                        ...track.clips[1]!,
                        startUs: 5_000_000,
                        durationUs: 5_000_000,
                        sourceInUs: 2_000_000,
                      },
                    ],
                  }
                : track,
            ),
          },
        },
        transitions: [
          {
            id: 'x',
            trackId: 'track-v1',
            leftClipId: 'clip-a',
            rightClipId: 'clip-b',
            type: 'crossfade',
            durationUs: 1_000_000,
          },
        ],
      } as unknown as JoyProjectV1;
      const plan = buildFfmpegRenderPlan(withMedia, 'mp4', {}, dir);
      expect(plan.skipped).toEqual([]);
      const graph = plan.args[plan.args.indexOf('-filter_complex') + 1]!;
      expect(graph).toMatch(/fade=t=in:st=5(\.0+)?:d=1(\.0+)?:alpha=1/);
      // The outgoing clip keeps playing under the incoming one for the fade.
      expect(graph).toMatch(/between\(t,0(\.0+)?,6(\.0+)?\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
