/**
 * Captions: a caption track holds caption clips, and each clip's text is drawn over the picture
 * for its time. The decoded frames show the text while it is on screen and not before it.
 * Captions use a system font (or JOY_MEDIA_CAPTION_FONT); without one the render refuses.
 * Real binary and real ffmpeg; fixtures are generated inside the sandbox.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSandbox, describeRun, type RunResult, type Sandbox } from './harness.js';
import { addClip, createProject, showProject, track } from './project-helpers.js';

const hasMediaTools = (): boolean =>
  spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

function ffmpeg(args: string[]): void {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(' ')} failed: ${r.stderr}`);
}

/** How many near-white pixels are in the lower fifth of the frame at `seconds`. */
function brightPixelsInCaptionBand(file: string, seconds: number): number {
  const r = spawnSync(
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
      'crop=iw:ih/5:0:ih*4/5,format=gray',
      '-f',
      'rawvideo',
      '-',
    ],
    { maxBuffer: 1 << 24 },
  );
  return [...r.stdout].filter((value) => value > 200).length;
}

function errorCode(r: RunResult): string {
  return (r.json() as { code: string }).code;
}

describe.skipIf(!hasMediaTools())(
  'captions are drawn over the picture while they are on screen',
  () => {
    let sb: Sandbox;
    let blue: string;

    beforeAll(() => {
      sb = createSandbox('timeline-captions');
      blue = sb.path('blue.mp4');
      ffmpeg([
        '-f',
        'lavfi',
        '-i',
        'color=c=blue:size=320x240:rate=30:duration=2',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        blue,
      ]);
    });
    afterAll(() => sb.cleanup());

    const project = (name: string): Promise<string> =>
      createProject(sb, name, ['--width', '320', '--height', '240']);

    const add = (id: string, args: string[]): Promise<RunResult> =>
      sb.run(['timeline', ...args, '--project', id, '--json']);

    it('add-track --family caption adds a caption track', async () => {
      const id = await project('Caption track');
      const r = await add(id, ['add-track', '--family', 'caption']);
      expect(r.code, describeRun(r)).toBe(0);
      expect((r.json() as { trackId: string }).trackId).toBe('track-c1');
      expect((await showProject(sb, id)).tracks.map((t) => t.id)).toContain('track-c1');
    });

    it('a caption on a picture track is refused, and nothing is written', async () => {
      const id = await project('Caption on picture');
      const before = await showProject(sb, id);
      const r = await add(id, [
        'add-caption',
        '--track',
        'track-v1',
        '--start',
        '0',
        '--duration',
        '1',
        '--text',
        'Hi',
      ]);
      expect(r.code, describeRun(r)).toBe(1);
      expect(errorCode(r)).toBe('TRACK_KIND_MISMATCH');
      expect(await showProject(sb, id)).toEqual(before);
    });

    it('a caption without text is a usage error', async () => {
      const id = await project('No text');
      await add(id, ['add-track', '--family', 'caption']);
      const r = await add(id, [
        'add-caption',
        '--track',
        'track-c1',
        '--start',
        '0',
        '--duration',
        '1',
      ]);
      expect(r.code, describeRun(r)).toBe(2);
    });

    it('a caption is drawn over the picture between its start and end, and not before', async () => {
      const id = await project('Decoded caption');
      await addClip(sb, id, { track: 'track-v1', duration: 2, asset: blue });
      await add(id, ['add-track', '--family', 'caption']);
      const added = await add(id, [
        'add-caption',
        '--track',
        'track-c1',
        '--start',
        '0.5',
        '--duration',
        '1',
        '--text',
        'HELLO WORLD',
      ]);
      expect(added.code, describeRun(added)).toBe(0);
      const out = sb.path('out-caption');
      const r = await sb.run(['render', '--project', id, '--out', out, '--json']);
      expect(r.code, describeRun(r)).toBe(0);
      const file = join(
        out,
        readdirSync(out).find((n) => n.endsWith('.mp4'))!,
      );
      expect(brightPixelsInCaptionBand(file, 1.0)).toBeGreaterThan(40);
      expect(brightPixelsInCaptionBand(file, 0.2)).toBeLessThan(5);
      expect(brightPixelsInCaptionBand(file, 1.9)).toBeLessThan(5);
    });

    it('caption text with punctuation that ffmpeg treats specially still renders', async () => {
      const id = await project('Escaping');
      await addClip(sb, id, { track: 'track-v1', duration: 2, asset: blue });
      await add(id, ['add-track', '--family', 'caption']);
      const added = await add(id, [
        'add-caption',
        '--track',
        'track-c1',
        '--start',
        '0',
        '--duration',
        '2',
        '--text',
        "It's 100%: fine, [ok]; \\done",
      ]);
      expect(added.code, describeRun(added)).toBe(0);
      const out = sb.path('out-escape');
      const r = await sb.run(['render', '--project', id, '--out', out, '--json']);
      expect(r.code, describeRun(r)).toBe(0);
      expect(readdirSync(out).some((n) => n.endsWith('.mp4'))).toBe(true);
    });

    it('a caption clip cannot be split, and nothing changes', async () => {
      const id = await project('Split caption');
      await add(id, ['add-track', '--family', 'caption']);
      const added = await add(id, [
        'add-caption',
        '--track',
        'track-c1',
        '--start',
        '0',
        '--duration',
        '2',
        '--text',
        'One two three',
      ]);
      const clipId = (added.json() as { clip: { id: string } }).clip.id;
      const before = await showProject(sb, id);
      const r = await add(id, ['split', '--clip', clipId, '--at', '1']);
      expect(r.code, describeRun(r)).toBe(1);
      expect(errorCode(r)).toBe('CAPTION_CLIP_SPLIT');
      expect(await showProject(sb, id)).toEqual(before);
    });

    it('without a caption font the render refuses rather than drawing no captions', async () => {
      const id = await project('No font');
      await addClip(sb, id, { track: 'track-v1', duration: 2, asset: blue });
      await add(id, ['add-track', '--family', 'caption']);
      await add(id, [
        'add-caption',
        '--track',
        'track-c1',
        '--start',
        '0',
        '--duration',
        '1',
        '--text',
        'Hi',
      ]);
      const out = sb.path('out-no-font');
      const r = await sb.run(['render', '--project', id, '--out', out, '--json'], {
        env: { JOY_MEDIA_CAPTION_FONT: sb.path('missing-font.ttf') },
      });
      expect(r.code, describeRun(r)).toBe(1);
      expect(r.stdout).toContain('unsupported-feature');
      expect(track(await showProject(sb, id), 'track-c1').clips).toHaveLength(1);
    });

    it('caption text is drawn literally: %{n} and 100% are not expanded by ffmpeg', async () => {
      const id = await project('Literal text');
      await addClip(sb, id, { track: 'track-v1', duration: 2, asset: blue });
      await add(id, ['add-track', '--family', 'caption']);
      const added = await add(id, [
        'add-caption',
        '--track',
        'track-c1',
        '--start',
        '0',
        '--duration',
        '2',
        '--text',
        '%{n} 100%',
      ]);
      expect(added.code, describeRun(added)).toBe(0);
      const out = sb.path('out-literal');
      const r = await sb.run(['render', '--project', id, '--out', out, '--json']);
      expect(r.code, describeRun(r)).toBe(0);
      const file = join(
        out,
        readdirSync(out).find((n) => n.endsWith('.mp4'))!,
      );
      expect(brightPixelsInCaptionBand(file, 1.0)).toBeGreaterThan(40);
    });

    it('a caption with an unknown direction or an invalid language is refused, and nothing is written', async () => {
      const id = await project('Bad caption flags');
      await add(id, ['add-track', '--family', 'caption']);
      const before = await showProject(sb, id);
      const direction = await add(id, [
        'add-caption',
        '--track',
        'track-c1',
        '--start',
        '0',
        '--duration',
        '1',
        '--text',
        'Hi',
        '--direction',
        'sideways',
      ]);
      expect(direction.code, describeRun(direction)).toBe(2);
      const language = await add(id, [
        'add-caption',
        '--track',
        'track-c1',
        '--start',
        '0',
        '--duration',
        '1',
        '--text',
        'Hi',
        '--language',
        'x y',
      ]);
      expect(language.code, describeRun(language)).toBe(2);
      expect(await showProject(sb, id)).toEqual(before);
    });

    it('a caption with more words than its duration allows a millisecond each is refused', async () => {
      const id = await project('Too many words');
      await add(id, ['add-track', '--family', 'caption']);
      const words = Array.from({ length: 1001 }, () => 'a').join(' ');
      const r = await add(id, [
        'add-caption',
        '--track',
        'track-c1',
        '--start',
        '0',
        '--duration',
        '0.001',
        '--text',
        words,
      ]);
      expect(r.code, describeRun(r)).toBe(2);
    });

    it('a caption after the end of the video still appears: the output runs as long as the caption', async () => {
      const id = await project('Caption after video');
      await addClip(sb, id, { track: 'track-v1', start: 0, duration: 1, asset: blue });
      await add(id, ['add-track', '--family', 'caption']);
      const added = await add(id, [
        'add-caption',
        '--track',
        'track-c1',
        '--start',
        '2',
        '--duration',
        '1',
        '--text',
        'Later',
      ]);
      expect(added.code, describeRun(added)).toBe(0);
      const out = sb.path('out-after-video');
      const r = await sb.run(['render', '--project', id, '--out', out, '--json']);
      expect(r.code, describeRun(r)).toBe(0);
      const file = join(
        out,
        readdirSync(out).find((n) => n.endsWith('.mp4'))!,
      );
      const probe = spawnSync(
        'ffprobe',
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
        { encoding: 'utf8' },
      );
      expect(Number(probe.stdout.trim())).toBeGreaterThan(2.9);
      expect(brightPixelsInCaptionBand(file, 2.5)).toBeGreaterThan(40);
    });
  },
);
