/** A complete mock-agent edit, real-media render, and fresh-process readback. */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createAgentSandbox,
  fakeKey,
  proposeTimeline,
  readProjects,
  startMockLlm,
  text,
  toolCalls,
  type AgentSandbox,
  type MockLlmServer,
} from './agent-helpers.js';
import { describeRun, hasAnsi } from './harness.js';

const HAS_FFMPEG = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const HAS_FFPROBE = spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;
const FIXTURE_MEDIA = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/test-fixtures/media/video.mp4',
);
const KEY = fakeKey('delivery');

describe.skipIf(!HAS_FFMPEG || !HAS_FFPROBE)(
  'mock-agent delivery journey (real CLI and real media)',
  () => {
    let mock: MockLlmServer;
    let env: AgentSandbox;
    let projectId: string;

    const provider = (): string[] => [
      '--url',
      mock.url,
      '--api-key',
      KEY,
      '--model',
      'mock/editor',
    ];

    beforeAll(async () => {
      mock = await startMockLlm();
    });
    afterAll(async () => {
      await mock.close();
    });
    beforeEach(async () => {
      mock.reset();
      env = createAgentSandbox('agent-delivery');
    });
    afterEach(() => {
      expect(env.externalCalls(), 'agent and renderer must remain offline').toEqual([]);
      env.cleanup();
    });

    it.each(['bin', 'bundle'] as const)(
      'corrects a rejected tool request, renders playable media, and reopens the saved edit via %s',
      async (entry) => {
        const help = await env.run(['help'], { entry });
        expect(help.code, describeRun(help)).toBe(0);
        expect(help.out).toMatch(/project|timeline|render/i);
        const previousIds = new Set(readProjects(env.sb).map((row) => row.id));
        const created = await env.run(['project', 'create', 'Mock Agent Delivery'], { entry });
        expect(created.code, describeRun(created)).toBe(0);
        const createdProject = readProjects(env.sb).find((row) => !previousIds.has(row.id));
        expect(createdProject).toBeDefined();
        projectId = createdProject!.id;

        const added = await env.run(
          ['timeline', 'add-clip', '--project', projectId, '--asset', FIXTURE_MEDIA, '--json'],
          { entry },
        );
        expect(added.code, describeRun(added)).toBe(0);
        const addedClip = added.json<{ clip: { id: string; assetId: string } }>().clip;
        const clipId = addedClip.id;
        expect(addedClip.assetId).not.toBe('');
        expect(readProjects(env.sb).find((row) => row.id === projectId)?.revision).toBe(2);

        mock.script(
          toolCalls({
            name: 'propose_timeline_operations',
            args: {
              operations: [
                { kind: 'split', id: 'invalid-split', clipId, atUs: '1000000', dependsOn: [] },
              ],
            },
          }),
          toolCalls(
            proposeTimeline(
              { kind: 'split', id: 'split-one', clipId, atUs: 1_000_000, dependsOn: [] },
              {
                kind: 'trim',
                id: 'trim-left',
                clipId,
                startUs: 0,
                endUs: 750_000,
                dependsOn: ['split-one'],
              },
            ),
          ),
          text('Corrected the split request, trimmed the opening, and prepared the video.'),
        );

        const agent = await env.run(
          [
            'agent',
            'run',
            'Split the source at one second and shorten the opening to 0.75 seconds.',
            '--project',
            projectId,
            '--apply',
            '--json',
            ...provider(),
          ],
          { entry },
        );
        expect(agent.code, describeRun(agent)).toBe(0);
        expect(agent.stderr).not.toContain(KEY);
        expect(agent.stderr).not.toMatch(/SQLite is an experimental feature/i);
        expect(hasAnsi(agent.stdout)).toBe(false);
        expect(agent.json<{ ok: boolean; applied: boolean; revision: number }>()).toMatchObject({
          ok: true,
          applied: true,
          revision: 3,
        });
        expect(mock.chatRequests).toHaveLength(3);
        const correctionContext = JSON.stringify(mock.chatRequests[1]?.json?.messages);
        expect(correctionContext).toMatch(/expected number/i);

        const row = readProjects(env.sb).find((candidate) => candidate.id === projectId)!;
        const root = row.payload.compositions[row.payload.rootCompositionId]!;
        const clips = root.tracks
          .flatMap((track) => track.clips)
          .sort((a, b) => a.startUs - b.startUs);
        expect(row.revision).toBe(3);
        expect(clips).toHaveLength(2);
        expect(clips.map(({ startUs, durationUs }) => [startUs, durationUs])).toEqual([
          [0, 750_000],
          [1_000_000, 2_000_000],
        ]);
        expect(clips[0]?.id).toBe(clipId);
        expect(clips[1]?.id).toMatch(new RegExp(`^${clipId}-split-`));

        const outDir = env.sb.path('delivery');
        const rendered = await env.run(
          ['render', '--project', projectId, '--out', outDir, '--json'],
          {
            entry,
            timeoutMs: 120_000,
          },
        );
        expect(rendered.code, describeRun(rendered)).toBe(0);
        expect(rendered.stderr).not.toMatch(/SQLite is an experimental feature/i);
        expect(hasAnsi(rendered.stdout)).toBe(false);
        const events = rendered.ndjson<{
          type: string;
          mediaProduced?: boolean;
          artifactPath?: string;
        }>();
        const complete = events.at(-1)!;
        const videoPath = env.sb.path('delivery', `${projectId}.mp4`);
        expect(complete).toMatchObject({
          type: 'complete',
          mediaProduced: true,
          artifactPath: videoPath,
        });
        expect(existsSync(`${videoPath}.manifest.json`)).toBe(true);

        const probe = spawnSync(
          'ffprobe',
          [
            '-v',
            'error',
            '-show_entries',
            'format=duration',
            '-show_entries',
            'stream=codec_type,codec_name',
            '-of',
            'json',
            videoPath,
          ],
          { encoding: 'utf8' },
        );
        expect(probe.status, probe.stderr).toBe(0);
        const media = JSON.parse(probe.stdout) as {
          format: { duration: string };
          streams: Array<{ codec_type: string; codec_name: string }>;
        };
        expect(media.streams).toContainEqual(
          expect.objectContaining({ codec_type: 'video', codec_name: 'h264' }),
        );
        expect(Number(media.format.duration)).toBeGreaterThan(2.9);
        expect(Number(media.format.duration)).toBeLessThan(3.1);

        const reopened = await env.run(['project', 'show', projectId], { entry });
        expect(reopened.code, describeRun(reopened)).toBe(0);
        expect(reopened.out).toMatch(/Revision: 3/);
        expect(reopened.out).toContain(clipId);
        expect(reopened.out).toContain(clips[1]!.id);
      },
      120_000,
    );
  },
);
