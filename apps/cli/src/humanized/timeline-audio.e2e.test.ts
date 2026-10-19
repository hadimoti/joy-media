/**
 * Per-clip audio settings (gain, mute, fade in, fade out) change the sound of the
 * decoded render, and invalid settings are refused without changing the project.
 * Real binary and real ffmpeg; the tone fixture is generated inside the sandbox.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSandbox, describeRun, type RunResult, type Sandbox } from './harness.js';
import { addClip, createProject, showProject } from './project-helpers.js';

const hasMediaTools = (): boolean =>
  spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

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

function errorCode(r: RunResult): string {
  return (r.json() as { code: string }).code;
}

describe.skipIf(!hasMediaTools())('per-clip audio settings change the decoded sound', () => {
  let sb: Sandbox;
  let tone: string;

  beforeAll(() => {
    sb = createSandbox('timeline-audio');
    tone = sb.path('tone.wav');
    const r = spawnSync(
      'ffmpeg',
      ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', tone],
      { encoding: 'utf8' },
    );
    if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
  });
  afterAll(() => sb.cleanup());

  /** A project with a two-second tone on the audio track; returns its id and clip id. */
  async function toneProject(name: string): Promise<{ id: string; clipId: string }> {
    const id = await createProject(sb, name, ['--width', '320', '--height', '240']);
    const clip = await addClip(sb, id, { track: 'track-a1', duration: 2, asset: tone });
    return { id, clipId: clip.id };
  }

  async function render(id: string, dir: string): Promise<string> {
    const out = sb.path(dir);
    const r = await sb.run(['render', '--project', id, '--out', out, '--json']);
    expect(r.code, describeRun(r)).toBe(0);
    return join(
      out,
      readdirSync(out).find((n) => n.endsWith('.mp4'))!,
    );
  }

  const setAudio = (id: string, args: string[]): Promise<RunResult> =>
    sb.run(['timeline', 'set-audio', '--project', id, ...args, '--json']);

  it('a gain of 0.25 lowers the decoded loudness by about 12 dB', async () => {
    const { id, clipId } = await toneProject('Gain');
    const loud = meanDb(await render(id, 'out-gain-1'), 0, 2);
    const set = await setAudio(id, ['--clip', clipId, '--gain', '0.25']);
    expect(set.code, describeRun(set)).toBe(0);
    const quiet = meanDb(await render(id, 'out-gain-2'), 0, 2);
    expect(loud - quiet).toBeGreaterThan(10);
    expect(loud - quiet).toBeLessThan(14);
  });

  it('mute silences the clip in the decoded output', async () => {
    const { id, clipId } = await toneProject('Mute');
    const set = await setAudio(id, ['--clip', clipId, '--mute']);
    expect(set.code, describeRun(set)).toBe(0);
    expect(meanDb(await render(id, 'out-mute'), 0, 2)).toBeLessThan(-60);
  });

  it('a fade-in makes the opening quieter than the body of the clip', async () => {
    const { id, clipId } = await toneProject('Fade in');
    const set = await setAudio(id, ['--clip', clipId, '--fade-in', '1']);
    expect(set.code, describeRun(set)).toBe(0);
    const file = await render(id, 'out-fade-in');
    expect(meanDb(file, 0, 0.4)).toBeLessThan(meanDb(file, 1.2, 1.6) - 6);
  });

  it('a fade-out makes the ending quieter than the body of the clip', async () => {
    const { id, clipId } = await toneProject('Fade out');
    const set = await setAudio(id, ['--clip', clipId, '--fade-out', '1']);
    expect(set.code, describeRun(set)).toBe(0);
    const file = await render(id, 'out-fade-out');
    expect(meanDb(file, 1.6, 2)).toBeLessThan(meanDb(file, 0.2, 0.6) - 6);
  });

  it('refuses a missing clip, a bad gain, and contradictory or empty settings, changing nothing', async () => {
    const { id, clipId } = await toneProject('Refusals');
    const before = await showProject(sb, id);

    const missing = await setAudio(id, ['--clip', 'clip-none', '--mute']);
    expect(missing.code, describeRun(missing)).toBe(1);
    expect(errorCode(missing)).toBe('CLIP_NOT_FOUND');

    const negative = await setAudio(id, ['--clip', clipId, '--gain', '-1']);
    expect(negative.code, describeRun(negative)).toBe(2);

    const both = await setAudio(id, ['--clip', clipId, '--mute', '--unmute']);
    expect(both.code, describeRun(both)).toBe(2);

    const empty = await setAudio(id, ['--clip', clipId]);
    expect(empty.code, describeRun(empty)).toBe(2);

    expect(await showProject(sb, id)).toEqual(before);
  });

  it('a fade longer than its clip is refused as a usage error', async () => {
    const { id, clipId } = await toneProject('Long fades');
    const r = await setAudio(id, ['--clip', clipId, '--fade-in', '1.5', '--fade-out', '1.5']);
    expect(r.code, describeRun(r)).toBe(2);
  });
});
