/**
 * Projects can use NTSC frame rates (23.976, 29.97, 59.94) and exact fractions,
 * not only whole numbers, and the rendered file really runs at that rate.
 * Real binary and real ffprobe; the fixture is generated in the sandbox.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSandbox, describeRun, type Sandbox } from './harness.js';
import { addClip, createProject, showProject } from './project-helpers.js';

const hasMediaTools = (): boolean =>
  spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

describe('project frame rates', () => {
  let sb: Sandbox;

  beforeAll(() => {
    sb = createSandbox('frame-rate');
  });
  afterAll(() => sb.cleanup());

  it.each([
    ['29.97', 30_000, 1001],
    ['30000/1001', 30_000, 1001],
    ['23.976', 24_000, 1001],
    ['59.94', 60_000, 1001],
    ['25', 25, 1],
  ])('--fps %s is stored as the exact rate %i/%i', async (fps, num, den) => {
    const id = await createProject(sb, `Rate ${fps}`, ['--fps', fps]);
    const show = await showProject(sb, id);
    expect(show.frameRate).toBeCloseTo(num / den, 6);
    const r = await sb.run(['project', 'show', id, '--json']);
    expect(r.code, describeRun(r)).toBe(0);
  });

  it('a rate that is neither a known NTSC value nor a fraction is a usage error', async () => {
    const r = await sb.run(['project', 'create', 'Odd', '--fps', '29.9', '--json']);
    expect(r.code, describeRun(r)).toBe(2);
  });
});

describe.skipIf(!hasMediaTools())('a 29.97 project renders a 29.97 file', () => {
  let sb: Sandbox;
  let red: string;

  beforeAll(() => {
    sb = createSandbox('frame-rate-render');
    red = sb.path('red.mp4');
    const r = spawnSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'color=c=red:size=320x240:rate=30:duration=2',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        red,
      ],
      { encoding: 'utf8' },
    );
    if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
  });
  afterAll(() => sb.cleanup());

  it('the file runs at 30000/1001 and carries about two seconds of frames', async () => {
    const id = await createProject(sb, 'NTSC', [
      '--width',
      '320',
      '--height',
      '240',
      '--fps',
      '29.97',
    ]);
    await addClip(sb, id, { track: 'track-v1', duration: 2, asset: red });
    const out = sb.path('out-ntsc');
    const r = await sb.run(['render', '--project', id, '--out', out, '--json']);
    expect(r.code, describeRun(r)).toBe(0);
    const file = join(
      out,
      readdirSync(out).find((n) => n.endsWith('.mp4'))!,
    );
    const probe = spawnSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-count_frames',
        '-show_entries',
        'stream=r_frame_rate,nb_read_frames',
        '-of',
        'csv=p=0',
        file,
      ],
      { encoding: 'utf8' },
    );
    const [rate, frames] = probe.stdout.trim().split(',');
    expect(rate).toBe('30000/1001');
    expect(Number(frames)).toBeGreaterThanOrEqual(59);
    expect(Number(frames)).toBeLessThanOrEqual(61);
  });
});
