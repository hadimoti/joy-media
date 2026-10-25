/**
 * Timeline authoring that the renderer really supports: adding a track and
 * moving a clip. The moved and added content is checked in the decoded output
 * (pixels at a time, loudness in a window), not only in the project file.
 * Real binary and real ffmpeg; fixtures are generated inside the sandbox.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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

function errorCode(r: RunResult): string {
  return (r.json() as { code: string }).code;
}

/** RGB of the centre pixel of the frame at `seconds`. */
function centreRgb(file: string, seconds: number): [number, number, number] {
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
      'crop=4:4:iw/2-2:ih/2-2,scale=1:1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-',
    ],
    { maxBuffer: 1 << 20 },
  );
  const bytes = [...r.stdout];
  return [bytes[0] ?? -1, bytes[1] ?? -1, bytes[2] ?? -1];
}

/** Mean loudness in dB of `[from, to)` seconds of the file's audio. */
function meanDb(file: string, from: number, to: number): number {
  const r = spawnSync(
    'ffmpeg',
    [
      '-v',
      'info',
      '-ss',
      String(from),
      '-t',
      String(to - from),
      '-i',
      file,
      '-vn',
      '-af',
      'volumedetect',
      '-f',
      'null',
      '-',
    ],
    { encoding: 'utf8' },
  );
  const match = /mean_volume: (-?[\d.]+) dB/.exec(r.stderr);
  return match ? Number(match[1]) : Number.NEGATIVE_INFINITY;
}

describe.skipIf(!hasMediaTools())('timeline authoring is checked in the decoded output', () => {
  let sb: Sandbox;
  let red: string;
  let tone: string;

  beforeAll(() => {
    sb = createSandbox('timeline-authoring');
    red = sb.path('red.mp4');
    tone = sb.path('tone.wav');
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'color=c=red:size=320x240:rate=30:duration=3',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      red,
    ]);
    ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', tone]);
  });
  afterAll(() => sb.cleanup());

  const project = (name: string): Promise<string> =>
    createProject(sb, name, ['--width', '320', '--height', '240']);

  const runTimeline = (args: string[]): Promise<RunResult> =>
    sb.run(['timeline', ...args, '--json']);

  it('add-track adds a visual track with the next id, and the timeline lists it', async () => {
    const id = await project('Add visual');
    const r = await runTimeline(['add-track', '--project', id, '--family', 'visual']);
    expect(r.code, describeRun(r)).toBe(0);
    const added = r.json() as { trackId: string };
    expect(added.trackId).toBe('track-v3');
    const show = await showProject(sb, id);
    expect(track(show, 'track-v3').family).toBe('visual');
  });

  it('add-track adds an audio track with the next audio id', async () => {
    const id = await project('Add audio');
    const r = await runTimeline(['add-track', '--project', id, '--family', 'audio']);
    expect(r.code, describeRun(r)).toBe(0);
    expect((r.json() as { trackId: string }).trackId).toBe('track-a2');
    expect(track(await showProject(sb, id), 'track-a2').family).toBe('audio');
  });

  it('add-track refuses an unknown family as a usage error and writes nothing', async () => {
    const id = await project('Bad family');
    const before = await showProject(sb, id);
    const r = await runTimeline(['add-track', '--project', id, '--family', 'video']);
    expect(r.code, describeRun(r)).toBe(2);
    expect(await showProject(sb, id)).toEqual(before);
  });

  it('clip move shifts a clip to a free position and leaves its source alone', async () => {
    const id = await project('Move free');
    const clip = await addClip(sb, id, { track: 'track-v1', duration: 2, asset: red });
    const r = await runTimeline(['move', '--project', id, '--clip', clip.id, '--start', '4']);
    expect(r.code, describeRun(r)).toBe(0);
    const moved = track(await showProject(sb, id), 'track-v1').clips.find((c) => c.id === clip.id);
    expect(moved?.startUs).toBe(4_000_000);
    expect(moved?.durationUs).toBe(2_000_000);
  });

  it('clip move onto another clip is refused and changes nothing', async () => {
    const id = await project('Move overlap');
    const a = await addClip(sb, id, { track: 'track-v1', start: 0, duration: 2, asset: red });
    await addClip(sb, id, { track: 'track-v1', start: 4, duration: 2, asset: red });
    const before = await showProject(sb, id);
    const r = await runTimeline(['move', '--project', id, '--clip', a.id, '--start', '3.5']);
    expect(r.code, describeRun(r)).toBe(1);
    expect(errorCode(r)).toBe('CLIP_OVERLAP');
    expect(await showProject(sb, id)).toEqual(before);
  });

  it('clip move refuses audio-only media onto a visual track', async () => {
    const id = await project('Move family');
    const music = await addClip(sb, id, { track: 'track-a1', duration: 2, asset: tone });
    const before = await showProject(sb, id);
    const r = await runTimeline([
      'move',
      '--project',
      id,
      '--clip',
      music.id,
      '--track',
      'track-v1',
    ]);
    expect(r.code, describeRun(r)).toBe(1);
    expect(errorCode(r)).toBe('TRACK_KIND_MISMATCH');
    expect(await showProject(sb, id)).toEqual(before);
  });

  it('clip move refuses a label clip onto a track of another family, even with no media record', async () => {
    const id = await project('Label family');
    const label = await addClip(sb, id, { track: 'track-v1', duration: 2, asset: 'intro' });
    const before = await showProject(sb, id);
    const r = await runTimeline([
      'move',
      '--project',
      id,
      '--clip',
      label.id,
      '--track',
      'track-a1',
    ]);
    expect(r.code, describeRun(r)).toBe(1);
    expect(errorCode(r)).toBe('TRACK_KIND_MISMATCH');
    expect(await showProject(sb, id)).toEqual(before);
  });

  it('clip move onto a disabled track is refused, and the clip stays where it was', async () => {
    const id = await project('Disabled destination');
    const clip = await addClip(sb, id, { track: 'track-v1', duration: 2, asset: red });
    const exported = sb.path('disabled-destination.json');
    expect((await sb.run(['project', 'export', id, '-o', exported])).code).toBe(0);
    const doc = JSON.parse(readFileSync(exported, 'utf8')) as {
      source: {
        rootCompositionId: string;
        compositions: Record<string, { tracks: Array<Record<string, unknown>> }>;
      };
    };
    const root = doc.source.compositions[doc.source.rootCompositionId]!;
    root.tracks.find((t) => t.id === 'track-v2')!.enabled = false;
    writeFileSync(exported, JSON.stringify(doc, null, 2));
    const before = await sb.run([
      'timeline',
      'move',
      '--project',
      exported,
      '--clip',
      clip.id,
      '--track',
      'track-v2',
      '--json',
    ]);
    expect(before.code, describeRun(before)).toBe(1);
    expect(errorCode(before)).toBe('TRACK_DISABLED');
    const show = await showProject(sb, exported);
    expect(track(show, 'track-v1').clips.map((c) => c.id)).toContain(clip.id);
  });

  it('a moved clip shows at its new time in the decoded output, and not at its old time', async () => {
    const id = await project('Decoded move');
    const clip = await addClip(sb, id, { track: 'track-v1', start: 0, duration: 2, asset: red });
    const moved = await runTimeline(['move', '--project', id, '--clip', clip.id, '--start', '3']);
    expect(moved.code, describeRun(moved)).toBe(0);
    const out = sb.path('out-decoded-move');
    const r = await sb.run(['render', '--project', id, '--out', out, '--json']);
    expect(r.code, describeRun(r)).toBe(0);
    const file = join(
      out,
      readdirSync(out).find((n) => n.endsWith('.mp4'))!,
    );
    expect(existsSync(file)).toBe(true);
    const [oldR, oldG] = centreRgb(file, 1);
    expect(oldR).toBeLessThan(80); // empty at 1 s: the clip has moved away
    expect(oldG).toBeLessThan(80);
    const [newR, newG] = centreRgb(file, 4);
    expect(newR).toBeGreaterThan(150); // the red clip at 3-5 s
    expect(newG).toBeLessThan(80);
  });

  it('a track added with add-track renders its audio into the decoded output', async () => {
    const id = await project('Decoded audio track');
    const added = await runTimeline(['add-track', '--project', id, '--family', 'audio']);
    const trackId = (added.json() as { trackId: string }).trackId;
    await addClip(sb, id, { track: trackId, start: 0, duration: 2, asset: tone });
    const out = sb.path('out-decoded-audio');
    const r = await sb.run(['render', '--project', id, '--out', out, '--json']);
    expect(r.code, describeRun(r)).toBe(0);
    const file = join(
      out,
      readdirSync(out).find((n) => n.endsWith('.mp4'))!,
    );
    expect(meanDb(file, 0, 2)).toBeGreaterThan(-40);
  });
});
