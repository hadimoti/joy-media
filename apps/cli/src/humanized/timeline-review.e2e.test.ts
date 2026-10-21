/**
 * Regression tests for problems found in the whole-branch review: a missing transition
 * duration, dissolves on audio, the order of overlapping clips, still pictures in a dissolve,
 * splitting a muted clip, the manifest frame rate, and moving between audio tracks.
 * Real binary and real ffmpeg; fixtures are generated inside the sandbox.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSandbox, describeRun, type RunResult, type Sandbox } from './harness.js';
import { addClip, createProject, showProject } from './project-helpers.js';

const hasMediaTools = (): boolean =>
  spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

function ffmpeg(args: string[]): void {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(' ')} failed: ${r.stderr}`);
}

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

function errorCode(r: RunResult): string {
  return (r.json() as { code: string }).code;
}

describe.skipIf(!hasMediaTools())('whole-branch review regressions', () => {
  let sb: Sandbox;
  let red: string;
  let blue: string;
  let tone: string;
  let redStill: string;
  let blueStill: string;

  beforeAll(() => {
    sb = createSandbox('timeline-review');
    red = sb.path('red.mp4');
    blue = sb.path('blue.mp4');
    tone = sb.path('tone.wav');
    redStill = sb.path('red.png');
    blueStill = sb.path('blue.png');
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'color=c=red:size=320x240:rate=30:duration=4',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      red,
    ]);
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:size=320x240:rate=30:duration=4',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      blue,
    ]);
    ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', tone]);
    ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:size=320x240', '-frames:v', '1', redStill]);
    ffmpeg(['-f', 'lavfi', '-i', 'color=c=blue:size=320x240', '-frames:v', '1', blueStill]);
  });
  afterAll(() => sb.cleanup());

  const project = (name: string): Promise<string> =>
    createProject(sb, name, ['--width', '320', '--height', '240']);

  async function render(id: string, dir: string): Promise<string> {
    const out = sb.path(dir);
    const r = await sb.run(['render', '--project', id, '--out', out, '--json']);
    expect(r.code, describeRun(r)).toBe(0);
    return join(
      out,
      readdirSync(out).find((n) => n.endsWith('.mp4'))!,
    );
  }

  /** Two touching red and blue clips with a handle on each side of the junction at 2.5 s. */
  async function dissolveSetup(
    name: string,
    addIncomingFirst: boolean,
  ): Promise<{ id: string; left: string; right: string }> {
    const id = await project(name);
    let left: string;
    let right: string;
    if (addIncomingFirst) {
      const b = await addClip(sb, id, { track: 'track-v1', start: 2, duration: 2.5, asset: blue });
      const a = await addClip(sb, id, { track: 'track-v1', start: 0, duration: 2, asset: red });
      left = a.id;
      right = b.id;
    } else {
      const a = await addClip(sb, id, { track: 'track-v1', start: 0, duration: 2, asset: red });
      const b = await addClip(sb, id, { track: 'track-v1', start: 2, duration: 2.5, asset: blue });
      left = a.id;
      right = b.id;
    }
    const trimmed = await sb.run([
      'timeline',
      'trim',
      '--project',
      id,
      '--clip',
      right,
      '--start',
      '2.5',
      '--end',
      '4.5',
      '--json',
    ]);
    expect(trimmed.code, describeRun(trimmed)).toBe(0);
    const extended = await sb.run([
      'timeline',
      'trim',
      '--project',
      id,
      '--clip',
      left,
      '--end',
      '2.5',
      '--json',
    ]);
    expect(extended.code, describeRun(extended)).toBe(0);
    return { id, left, right };
  }

  it('add-transition without --duration is a usage error, and nothing is written', async () => {
    const id = await project('No duration');
    const a = await addClip(sb, id, { track: 'track-v1', start: 0, duration: 2, asset: 'label-a' });
    const b = await addClip(sb, id, { track: 'track-v1', start: 2, duration: 2, asset: 'label-b' });
    const before = await showProject(sb, id);
    const r = await sb.run([
      'timeline',
      'add-transition',
      '--project',
      id,
      '--left',
      a.id,
      '--right',
      b.id,
      '--json',
    ]);
    expect(r.code, describeRun(r)).toBe(2);
    expect(await showProject(sb, id)).toEqual(before);
  });

  it('a dissolve on an audio track is refused, and nothing is written', async () => {
    const id = await project('Audio dissolve');
    // Two touching tone clips, each with media past the junction, so only the audio family can refuse it.
    const a = await addClip(sb, id, { track: 'track-a1', start: 0, duration: 1, asset: tone });
    const b = await addClip(sb, id, { track: 'track-a1', start: 1, duration: 1.5, asset: tone });
    const trimmed = await sb.run([
      'timeline',
      'trim',
      '--project',
      id,
      '--clip',
      b.id,
      '--start',
      '1.2',
      '--end',
      '2.5',
      '--json',
    ]);
    expect(trimmed.code, describeRun(trimmed)).toBe(0);
    const extended = await sb.run([
      'timeline',
      'trim',
      '--project',
      id,
      '--clip',
      a.id,
      '--end',
      '1.2',
      '--json',
    ]);
    expect(extended.code, describeRun(extended)).toBe(0);
    const before = await showProject(sb, id);
    const r = await sb.run([
      'timeline',
      'add-transition',
      '--project',
      id,
      '--left',
      a.id,
      '--right',
      b.id,
      '--duration',
      '0.4',
      '--json',
    ]);
    expect(r.code, describeRun(r)).toBe(1);
    expect(errorCode(r)).toBe('TRANSITION_INVALID');
    expect(await showProject(sb, id)).toEqual(before);
  });

  it('a dissolve between still pictures blends and never shows black after the outgoing picture', async () => {
    const id = await project('Still dissolve');
    const a = await addClip(sb, id, { track: 'track-v1', start: 0, duration: 2, asset: redStill });
    const b = await addClip(sb, id, { track: 'track-v1', start: 2, duration: 2, asset: blueStill });
    const added = await sb.run([
      'timeline',
      'add-transition',
      '--project',
      id,
      '--left',
      a.id,
      '--right',
      b.id,
      '--duration',
      '1',
      '--json',
    ]);
    expect(added.code, describeRun(added)).toBe(0);
    const file = await render(id, 'out-still-dissolve');
    // The stills meet at 2 s and the dissolve runs 1.5-2.5 s: half red, half blue at 2 s,
    // pure blue once it is over, and never black.
    const [midR, , midB] = centreRgb(file, 2);
    expect(midR).toBeGreaterThan(80);
    expect(midB).toBeGreaterThan(80);
    const [lateR, lateG, lateB] = centreRgb(file, 3.5);
    expect(lateB).toBeGreaterThan(150);
    expect(lateR + lateG).toBeLessThan(80);
  });

  it('a dissolve blends the same way when the incoming clip was added first', async () => {
    const { id } = await dissolveSetup('Incoming first', true);
    const added = await sb.run([
      'timeline',
      'add-transition',
      '--project',
      id,
      '--left',
      (await showProject(sb, id)).tracks[0]!.clips.find((c) => c.startUs === 0)!.id,
      '--right',
      (await showProject(sb, id)).tracks[0]!.clips.find((c) => c.startUs === 2_500_000)!.id,
      '--duration',
      '1',
      '--json',
    ]);
    expect(added.code, describeRun(added)).toBe(0);
    const file = await render(id, 'out-incoming-first');
    const [midR, midG, midB] = centreRgb(file, 2.5);
    expect(midR).toBeGreaterThan(80);
    expect(midR).toBeLessThan(180);
    expect(midB).toBeGreaterThan(80);
    expect(midB).toBeLessThan(180);
    expect(midG).toBeLessThan(60);
  });

  it('splitting a muted clip keeps the second part muted', async () => {
    const id = await project('Mute split');
    const clip = await addClip(sb, id, { track: 'track-a1', start: 0, duration: 2, asset: tone });
    expect(
      (
        await sb.run([
          'timeline',
          'set-audio',
          '--project',
          id,
          '--clip',
          clip.id,
          '--mute',
          '--json',
        ])
      ).code,
    ).toBe(0);
    const split = await sb.run([
      'timeline',
      'split',
      '--project',
      id,
      '--clip',
      clip.id,
      '--at',
      '1',
      '--json',
    ]);
    expect(split.code, describeRun(split)).toBe(0);
    const file = await render(id, 'out-mute-split');
    expect(meanDb(file, 1.2, 1.8)).toBeLessThan(-60);
  });

  it('moving a clip between the default audio track and a new audio track is allowed', async () => {
    const id = await project('Audio move');
    const clip = await addClip(sb, id, { track: 'track-a1', start: 0, duration: 1, asset: tone });
    const added = await sb.run([
      'timeline',
      'add-track',
      '--project',
      id,
      '--family',
      'audio',
      '--json',
    ]);
    expect(added.code, describeRun(added)).toBe(0);
    const trackId = (added.json() as { trackId: string }).trackId;
    const moved = await sb.run([
      'timeline',
      'move',
      '--project',
      id,
      '--clip',
      clip.id,
      '--track',
      trackId,
      '--json',
    ]);
    expect(moved.code, describeRun(moved)).toBe(0);
  });

  it('the manifest reports the rate a real render is encoded at', async () => {
    const id = await createProject(sb, 'Rate 25', [
      '--width',
      '320',
      '--height',
      '240',
      '--fps',
      '25',
    ]);
    await addClip(sb, id, { track: 'track-v1', start: 0, duration: 2, asset: red });
    const out = sb.path('out-rate-25');
    const r = await sb.run(['render', '--project', id, '--out', out, '--json']);
    expect(r.code, describeRun(r)).toBe(0);
    const manifestName = readdirSync(out).find((n) => n.endsWith('.manifest.json'))!;
    const manifest = JSON.parse(readFileSync(join(out, manifestName), 'utf8')) as {
      spec: { fps: number };
    };
    expect(manifest.spec.fps).toBe(25);
  });
});
