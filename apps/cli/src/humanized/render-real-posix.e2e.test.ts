/**
 * POSIX signal cases from render-real.e2e.test.ts. SIGINT and SIGTERM exit statuses do not apply to
 * Windows, so the Windows lifecycle step does not run this file. The Linux CLI suite runs it.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSandbox, describeRun, type RunResult, type Sandbox } from './harness.js';

const hasTool = (name: string): boolean => spawnSync(name, ['-version']).status === 0;
const HAS_FFMPEG = hasTool('ffmpeg') && hasTool('ffprobe');

function ff(...args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-v', 'error', '-y', ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (status) => {
      if (status === 0) resolve();
      else reject(new Error(`ffmpeg ${args.join(' ')} failed: ${stderr}`));
    });
  });
}

describe.skipIf(!HAS_FFMPEG || process.platform === 'win32')(
  'render cancellation by POSIX signal',
  () => {
    let sb: Sandbox;
    let media: (name: string) => string;

    beforeAll(() => {
      sb = createSandbox('render-real-posix');
      media = (name) => sb.path('media', name);
      mkdirSync(sb.path('media'), { recursive: true });
    });
    afterAll(() => sb.cleanup());

    const run = (args: string[], env?: Record<string, string | undefined>): Promise<RunResult> =>
      sb.run(args, { timeoutMs: 120_000, ...(env ? { env } : {}) });

    async function newProject(name: string): Promise<string> {
      const r = await run([
        'project',
        'create',
        name,
        '--width',
        '1280',
        '--height',
        '720',
        '--fps',
        '30',
        '--json',
      ]);
      expect(r.code, describeRun(r)).toBe(0);
      return r.json<{ id: string }>().id;
    }

    async function addClip(project: string, extra: string[]): Promise<string> {
      const r = await run(['timeline', 'add-clip', '--project', project, ...extra, '--json']);
      expect(r.code, describeRun(r)).toBe(0);
      return r.json<{ clip: { id: string } }>().clip.id;
    }

    it.skipIf(process.platform === 'win32').each([
      { signal: 'SIGINT' as const, exitCode: 130 },
      { signal: 'SIGTERM' as const, exitCode: 143 },
    ])(
      '%s in the middle of an encode exits with its signal status and leaves no half-written video behind',
      async ({ signal, exitCode }) => {
        await ff(
          '-f',
          'lavfi',
          '-i',
          'testsrc2=s=1280x720:r=30:d=90',
          '-f',
          'lavfi',
          '-i',
          'sine=f=300:d=90',
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-c:a',
          'aac',
          media('long.mp4'),
        );
        const id = await newProject('Long');
        await addClip(id, ['--asset', media('long.mp4')]);
        const r = await sb.run(['render', '--project', id, '--out', sb.path('out8'), '--json'], {
          signal,
          signalAfterMs: 2500,
          timeoutMs: 120_000,
        });
        expect(r.code, describeRun(r)).toBe(exitCode);
        expect(r.ndjson<{ type: string; code?: string }>().at(-1)).toMatchObject({
          type: 'error',
          code: 'cancelled',
        });
        const left = existsSync(sb.path('out8')) ? readdirSync(sb.path('out8')) : [];
        expect(left).toEqual([]);
      },
      240_000,
    );
  },
);
