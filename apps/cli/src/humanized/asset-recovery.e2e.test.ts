import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI_ROOT, createSandbox, describeRun, type Sandbox } from './harness.js';
import { addClip, createProject, type ShowDoc } from './project-helpers.js';

const hasMediaTools = (): boolean =>
  spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

describe.skipIf(!hasMediaTools())('asset portability and recovery', () => {
  let original: Sandbox;
  const mediaSource = resolve(
    CLI_ROOT,
    '..',
    '..',
    'packages',
    'test-fixtures',
    'media',
    'readiness-hard-cut.mkv',
  );

  beforeAll(() => {
    original = createSandbox('asset-origin');
  });
  afterAll(() => original.cleanup());

  it('imports into a fresh profile, reports the missing file, and renders after explicit media-dir relink', async () => {
    const fileName = 'نمونه source with spaces.mkv';
    const originalMediaDir = original.path('creator media');
    mkdirSync(originalMediaDir, { recursive: true });
    const originalMediaPath = join(originalMediaDir, fileName);
    copyFileSync(mediaSource, originalMediaPath);

    const projectId = await createProject(original, 'Portable reel');
    await addClip(original, projectId, { asset: originalMediaPath });
    const exportPath = original.path('portable-project.json');
    const exported = await original.run([
      'project',
      'export',
      projectId,
      '--output',
      exportPath,
      '--json',
    ]);
    expect(exported.code, describeRun(exported)).toBe(0);

    const destination = createSandbox('asset-destination');
    try {
      const imported = await destination.run(['project', 'import', exportPath, '--json']);
      expect(imported.code, describeRun(imported)).toBe(0);
      const readback = await destination.run(['project', 'show', projectId, '--json']);
      expect(readback.code, describeRun(readback)).toBe(0);
      const project = readback.json<ShowDoc>();
      expect(project.tracks.flatMap((track) => track.clips)).toHaveLength(1);

      rmSync(originalMediaPath);
      const relocatedMediaDir = destination.path('new media location');
      mkdirSync(relocatedMediaDir, { recursive: true });
      copyFileSync(mediaSource, join(relocatedMediaDir, fileName));

      const missing = await destination.run([
        'render',
        '--project',
        projectId,
        '--out',
        destination.path('missing-media-output'),
        '--json',
      ]);
      expect(missing.code, describeRun(missing)).toBe(1);
      expect(missing.ndjson<{ type: string; code?: string }>().at(-1)).toMatchObject({
        type: 'error',
        code: 'media-missing',
      });
      expect(existsSync(destination.path('missing-media-output'))).toBe(false);

      const rendered = await destination.run([
        'render',
        '--project',
        projectId,
        '--media-dir',
        relocatedMediaDir,
        '--out',
        destination.path('relinked-output'),
        '--json',
      ]);
      expect(rendered.code, describeRun(rendered)).toBe(0);
      const complete = rendered
        .ndjson<{ type: string; mediaProduced?: boolean; mediaPath?: string }>()
        .at(-1)!;
      expect(complete).toMatchObject({ type: 'complete', mediaProduced: true });
      const probed = spawnSync(
        'ffprobe',
        [
          '-v',
          'error',
          '-show_entries',
          'stream=codec_type,codec_name',
          '-show_entries',
          'format=duration',
          '-of',
          'json',
          String(complete.mediaPath),
        ],
        { encoding: 'utf8' },
      );
      expect(probed.status, probed.stderr).toBe(0);
      const decoded = JSON.parse(probed.stdout) as {
        format: { duration: string };
        streams: Array<{ codec_type: string; codec_name: string }>;
      };
      expect(decoded.streams).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ codec_type: 'video', codec_name: expect.any(String) }),
          expect.objectContaining({ codec_type: 'audio', codec_name: expect.any(String) }),
        ]),
      );
      expect(Number(decoded.format.duration)).toBeGreaterThan(1.9);
    } finally {
      destination.cleanup();
    }
  }, 120_000);
});
