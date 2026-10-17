/**
 * `joy-media render` makes REAL video: these tests build a timeline out of real media files through
 * the CLI (the way a creator or an AI agent would), render it, and then inspect the resulting file
 * with ffprobe/ffmpeg: size, length, codecs, and which colour is on screen at which second.
 *
 * Skipped when ffmpeg/ffprobe are not installed.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSandbox, describeRun, type RunResult, type Sandbox } from './harness.js';

const hasTool = (name: string): boolean => spawnSync(name, ['-version']).status === 0;
const HAS_FFMPEG = hasTool('ffmpeg') && hasTool('ffprobe');

type Rgb = readonly [number, number, number];

function ff(...args: string[]): void {
  const res = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`ffmpeg ${args.join(' ')} failed: ${res.stderr}`);
}

function colourAt(file: string, seconds: number): Rgb {
  const res = spawnSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-ss',
      String(seconds),
      '-i',
      file,
      '-frames:v',
      '1',
      '-vf',
      'scale=1:1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-',
    ],
    { maxBuffer: 1024 },
  );
  const b = res.stdout;
  return [b[0] ?? -1, b[1] ?? -1, b[2] ?? -1];
}

const isRed = ([r, g, b]: Rgb): boolean => r > 200 && g < 60 && b < 60;
const isBlue = ([r, g, b]: Rgb): boolean => b > 200 && r < 60 && g < 60;
const isGreen = ([r, g, b]: Rgb): boolean => g > 120 && r < 60 && b < 60;
const isBlack = ([r, g, b]: Rgb): boolean => r < 30 && g < 30 && b < 30;

function probe(file: string): {
  durationS: number;
  width: number;
  height: number;
  fps: string;
  video: string;
  audio: string | undefined;
} {
  const res = spawnSync(
    'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file],
    { encoding: 'utf8' },
  );
  const doc = JSON.parse(res.stdout) as {
    format: { duration: string };
    streams: Array<{
      codec_type: string;
      codec_name: string;
      width?: number;
      height?: number;
      r_frame_rate: string;
    }>;
  };
  const v = doc.streams.find((s) => s.codec_type === 'video')!;
  const a = doc.streams.find((s) => s.codec_type === 'audio');
  return {
    durationS: Number(doc.format.duration),
    width: v.width ?? 0,
    height: v.height ?? 0,
    fps: v.r_frame_rate,
    video: v.codec_name,
    audio: a?.codec_name,
  };
}

describe.skipIf(!HAS_FFMPEG)('render makes real video (real binary + real ffmpeg)', () => {
  let sb: Sandbox;
  let media: (name: string) => string;

  beforeAll(() => {
    sb = createSandbox('render-real');
    media = (name) => sb.path('media', name);
    mkdirSync(sb.path('media'), { recursive: true });
    ff(
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=640x360:r=25:d=3',
      '-f',
      'lavfi',
      '-i',
      'sine=f=440:d=3',
      '-shortest',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      media('red.mp4'),
    );
    ff(
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=1280x720:r=30:d=2',
      '-f',
      'lavfi',
      '-i',
      'sine=f=880:d=2',
      '-shortest',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      media('blue.mp4'),
    );
    // red for 2 s, then blue for 2 s, one continuous source
    ff(
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=640x360:r=25:d=2',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=640x360:r=25:d=2',
      '-f',
      'lavfi',
      '-i',
      'sine=f=440:d=4',
      '-filter_complex',
      '[0:v][1:v]concat=n=2:v=1:a=0[v]',
      '-map',
      '[v]',
      '-map',
      '2:a',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      media('redblue.mp4'),
    );
    ff('-f', 'lavfi', '-i', 'color=c=lime:s=400x400', '-frames:v', '1', media('green.png'));
    ff('-f', 'lavfi', '-i', 'sine=f=660:d=3', media('tone.wav'));
  }, 120_000);
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

  it('a creator joins a red clip and a blue clip and gets one 5 s 1280x720 H.264+AAC video with the right picture at the right time', async () => {
    const id = await newProject('Red then blue');
    await addClip(id, ['--asset', media('red.mp4')]);
    await addClip(id, ['--asset', media('blue.mp4'), '--start', '3']);

    const r = await run(['render', '--project', id, '--out', sb.path('out1'), '--json']);
    expect(r.code, describeRun(r)).toBe(0);
    const events = r.ndjson<{ type: string; mediaProduced?: boolean; artifactPath?: string }>();
    const done = events.at(-1)!;
    expect(done.type).toBe('complete');
    expect(done.mediaProduced).toBe(true);
    expect(events.some((e) => e.type === 'progress')).toBe(true);

    const file = sb.path('out1', `${id}.mp4`);
    expect(done.artifactPath).toBe(file);
    expect(existsSync(`${file}.manifest.json`)).toBe(true);
    const info = probe(file);
    expect(info).toMatchObject({
      width: 1280,
      height: 720,
      fps: '30/1',
      video: 'h264',
      audio: 'aac',
    });
    expect(info.durationS).toBeGreaterThan(4.9);
    expect(info.durationS).toBeLessThan(5.1);
    expect(isRed(colourAt(file, 0.5))).toBe(true);
    expect(isRed(colourAt(file, 2.8))).toBe(true);
    expect(isBlue(colourAt(file, 3.3))).toBe(true);
    expect(isBlue(colourAt(file, 4.7))).toBe(true);
    // nothing but the finished video and its manifest is left behind
    expect(readdirSync(sb.path('out1')).sort()).toEqual([`${id}.mp4`, `${id}.mp4.manifest.json`]);
  }, 120_000);

  it('the single-file bundle entry point also returns a playable video', async () => {
    const id = await newProject('Bundle render');
    await addClip(id, ['--asset', media('blue.mp4')]);

    const result = await sb.run(
      ['render', '--project', id, '--out', sb.path('bundle-out'), '--json'],
      { entry: 'bundle', timeoutMs: 120_000 },
    );

    expect(result.code, describeRun(result)).toBe(0);
    const complete = result.ndjson<{ type: string; mediaProduced?: boolean }>().at(-1)!;
    expect(complete).toMatchObject({ type: 'complete', mediaProduced: true });
    const file = sb.path('bundle-out', `${id}.mp4`);
    expect(existsSync(file)).toBe(true);
    expect(probe(file)).toMatchObject({ video: 'h264', audio: 'aac' });
    expect(isBlue(colourAt(file, 1))).toBe(true);
  }, 120_000);

  it('replaces an earlier playable render and manifest at the same output path', async () => {
    const id = await newProject('Replace output');
    await addClip(id, ['--asset', media('red.mp4')]);
    const outDir = sb.path('replace-output');
    const first = await run(['render', '--project', id, '--out', outDir, '--json']);
    expect(first.code, describeRun(first)).toBe(0);
    const file = sb.path('replace-output', `${id}.mp4`);
    const firstBytes = readFileSync(file);
    await addClip(id, ['--asset', media('blue.mp4'), '--start', '3']);

    const second = await run(['render', '--project', id, '--out', outDir, '--json']);

    expect(second.code, describeRun(second)).toBe(0);
    expect(second.ndjson<{ type: string; mediaProduced?: boolean }>().at(-1)).toMatchObject({
      type: 'complete',
      mediaProduced: true,
    });
    expect(readFileSync(file)).not.toEqual(firstBytes);
    expect(probe(file).video).toBe('h264');
    expect(probe(file).durationS).toBeGreaterThan(4.9);
    expect(isBlue(colourAt(file, 3.5))).toBe(true);
    expect(JSON.parse(readFileSync(`${file}.manifest.json`, 'utf8'))).toMatchObject({
      mediaProduced: true,
      projectId: id,
      totalFrames: 150,
    });
    expect(readdirSync(outDir).sort()).toEqual([`${id}.mp4`, `${id}.mp4.manifest.json`]);
  }, 120_000);

  it('preserves an earlier playable render and manifest when the next encode fails', async () => {
    const id = await newProject('Keep prior output');
    await addClip(id, ['--asset', media('red.mp4')]);
    const outDir = sb.path('keep-prior-output');
    const first = await run(['render', '--project', id, '--out', outDir, '--json']);
    expect(first.code, describeRun(first)).toBe(0);
    const file = sb.path('keep-prior-output', `${id}.mp4`);
    const originalVideo = readFileSync(file);
    const originalManifest = readFileSync(`${file}.manifest.json`);

    const failed = await run(['render', '--project', id, '--out', outDir, '--json'], {
      JOY_MEDIA_FFMPEG: '/nonexistent/ffmpeg',
    });

    expect(failed.code, describeRun(failed)).toBe(1);
    expect(failed.ndjson<{ type: string; code?: string }>().at(-1)).toMatchObject({
      type: 'error',
      code: 'ffmpeg-missing',
    });
    expect(readFileSync(file)).toEqual(originalVideo);
    expect(readFileSync(`${file}.manifest.json`)).toEqual(originalManifest);
    expect(readdirSync(outDir).sort()).toEqual([`${id}.mp4`, `${id}.mp4.manifest.json`]);
  }, 120_000);

  it('does not leave newly rendered media when the manifest destination cannot be written', async () => {
    const id = await newProject('Blocked manifest');
    await addClip(id, ['--asset', media('red.mp4')]);
    const outDir = sb.path('blocked-real-manifest');
    const manifestPath = sb.path('blocked-real-manifest', `${id}.mp4.manifest.json`);
    mkdirSync(manifestPath, { recursive: true });
    writeFileSync(sb.path('blocked-real-manifest', `${id}.mp4.manifest.json`, 'keep.txt'), 'keep');

    const result = await run(['render', '--project', id, '--out', outDir, '--json']);

    expect(result.code, describeRun(result)).toBe(1);
    expect(result.ndjson<{ type: string; code?: string }>().at(-1)).toMatchObject({
      type: 'error',
      code: 'output',
    });
    expect(existsSync(sb.path('blocked-real-manifest', `${id}.mp4`))).toBe(false);
    expect(readdirSync(outDir).sort()).toEqual([`${id}.mp4.manifest.json`]);
    expect(
      readFileSync(sb.path('blocked-real-manifest', `${id}.mp4.manifest.json`, 'keep.txt'), 'utf8'),
    ).toBe('keep');
  }, 120_000);

  it('a still image on the second video track covers the first track only while it is on screen, and an audio file extends the video', async () => {
    const id = await newProject('Overlay');
    await addClip(id, ['--asset', media('red.mp4')]);
    await addClip(id, [
      '--track',
      'track-v2',
      '--asset',
      media('green.png'),
      '--start',
      '1',
      '--duration',
      '1',
    ]);
    await addClip(id, ['--track', 'track-a1', '--asset', media('tone.wav'), '--start', '0.5']);

    const r = await run(['render', '--project', id, '--out', sb.path('out2'), '--json']);
    expect(r.code, describeRun(r)).toBe(0);
    const file = sb.path('out2', `${id}.mp4`);
    expect(isRed(colourAt(file, 0.5))).toBe(true);
    expect(isGreen(colourAt(file, 1.5))).toBe(true);
    expect(isRed(colourAt(file, 2.5))).toBe(true);
    // the tone runs 0.5 s -> 3.5 s, past the end of the 3 s video clip
    expect(probe(file).durationS).toBeGreaterThan(3.4);
    expect(probe(file).durationS).toBeLessThan(3.6);
  }, 120_000);

  it('trimming the head of a clip keeps the same frames on screen: black where the clip no longer is, blue where its blue half now starts', async () => {
    const id = await newProject('Trim head');
    const clip = await addClip(id, ['--asset', media('redblue.mp4')]);
    const t = await run([
      'timeline',
      'trim',
      '--project',
      id,
      '--clip',
      clip,
      '--start',
      '2',
      '--end',
      '4',
      '--json',
    ]);
    expect(t.code, describeRun(t)).toBe(0);

    const r = await run(['render', '--project', id, '--out', sb.path('out3'), '--json']);
    expect(r.code, describeRun(r)).toBe(0);
    const file = sb.path('out3', `${id}.mp4`);
    expect(isBlack(colourAt(file, 1))).toBe(true);
    expect(isBlue(colourAt(file, 2.5))).toBe(true);
    expect(isBlue(colourAt(file, 3.5))).toBe(true);
    expect(probe(file).durationS).toBeGreaterThan(3.9);
    expect(probe(file).durationS).toBeLessThan(4.1);
  }, 120_000);

  it('webm and prores presets produce the matching codecs', async () => {
    const id = await newProject('Presets');
    await addClip(id, ['--asset', media('blue.mp4')]);
    expect(
      (
        await run([
          'render',
          '--project',
          id,
          '--preset',
          'webm',
          '--out',
          sb.path('out4'),
          '--json',
        ])
      ).code,
    ).toBe(0);
    expect(
      (
        await run([
          'render',
          '--project',
          id,
          '--preset',
          'prores',
          '--out',
          sb.path('out4'),
          '--json',
        ])
      ).code,
    ).toBe(0);
    expect(probe(sb.path('out4', `${id}.webm`)).video).toBe('vp9');
    expect(probe(sb.path('out4', `${id}.mov`)).video).toBe('prores');
  }, 180_000);

  it('a source file that disappears after it was added makes render fail loudly, with nothing written', async () => {
    const id = await newProject('Vanishing source');
    ff(
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=320x180:r=25:d=1',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      media('temp.mp4'),
    );
    await addClip(id, ['--asset', media('temp.mp4')]);
    rmSync(media('temp.mp4'));

    const r = await run(['render', '--project', id, '--out', sb.path('out5'), '--json']);
    expect(r.code, describeRun(r)).toBe(1);
    const last = r.ndjson<{ type: string; code?: string; message?: string }>().at(-1)!;
    expect(last).toMatchObject({ type: 'error', code: 'media-missing' });
    expect(last.message).toContain('temp.mp4');
    expect(existsSync(sb.path('out5'))).toBe(false);
  }, 120_000);

  it('a label-only project (no real files) still writes only the honest manifest, and --manifest-only never needs ffmpeg', async () => {
    const id = await newProject('Labels');
    await addClip(id, ['--asset', 'intro-label']);
    const r = await run(['render', '--project', id, '--out', sb.path('out6'), '--json']);
    expect(r.code, describeRun(r)).toBe(0);
    expect(r.ndjson<{ type: string; mediaProduced?: boolean }>().at(-1)).toMatchObject({
      type: 'complete',
      mediaProduced: false,
    });

    const real = await newProject('Real but plan only');
    await addClip(real, ['--asset', media('red.mp4')]);
    const m = await run(
      ['render', '--project', real, '--manifest-only', '--out', sb.path('out6'), '--json'],
      {
        JOY_MEDIA_FFMPEG: '/nonexistent/ffmpeg',
      },
    );
    expect(m.code, describeRun(m)).toBe(0);
    expect(m.ndjson<{ mediaProduced?: boolean }>().at(-1)?.mediaProduced).toBe(false);
  }, 120_000);

  it('a machine without ffmpeg gets a clear error naming JOY_MEDIA_FFMPEG, not a stack trace', async () => {
    const id = await newProject('No encoder');
    await addClip(id, ['--asset', media('red.mp4')]);
    const r = await run(['render', '--project', id, '--out', sb.path('out7'), '--json'], {
      JOY_MEDIA_FFMPEG: '/nonexistent/ffmpeg',
    });
    expect(r.code, describeRun(r)).toBe(1);
    const last = r.ndjson<{ type: string; code?: string; message?: string }>().at(-1)!;
    expect(last).toMatchObject({ type: 'error', code: 'ffmpeg-missing' });
    expect(last.message).toContain('JOY_MEDIA_FFMPEG');
    expect(r.err).not.toMatch(/\bat .*\(.*:\d+:\d+\)/);
  }, 120_000);

  it('adding something that is not media gives a clear error and leaves the project untouched', async () => {
    const id = await newProject('Junk file');
    writeFileSync(media('notes.txt'), 'hello');
    const r = await run([
      'timeline',
      'add-clip',
      '--project',
      id,
      '--asset',
      media('notes.txt'),
      '--json',
    ]);
    expect(r.code, describeRun(r)).toBe(1);
    expect(r.out + r.err).toMatch(/not media|ffprobe/i);
    const shown = await run(['project', 'show', id, '--json']);
    expect(JSON.stringify(shown.json())).not.toContain('notes.txt');
  }, 120_000);

  it.skipIf(process.platform === 'win32')(
    'Ctrl-C in the middle of an encode exits 130 and leaves no half-written video behind',
    async () => {
      ff(
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
        signal: 'SIGINT',
        signalAfterMs: 2500,
        timeoutMs: 120_000,
      });
      expect(r.code, describeRun(r)).toBe(130);
      expect(r.ndjson<{ type: string; code?: string }>().at(-1)).toMatchObject({
        type: 'error',
        code: 'cancelled',
      });
      const left = existsSync(sb.path('out8')) ? readdirSync(sb.path('out8')) : [];
      expect(left).toEqual([]);
    },
    240_000,
  );
});
