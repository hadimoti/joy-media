/**
 * Dissolve transitions between two touching video clips. The decoded output shows
 * the left clip before the junction, a blend across it, and the right clip after it.
 * Transitions need media beyond each clip's edge (handles); without it they are refused.
 * Real binary and real ffmpeg; fixtures are generated in the sandbox.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
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

function errorCode(r: RunResult): string {
  return (r.json() as { code: string }).code;
}

describe.skipIf(!hasMediaTools())('dissolve transitions are rendered and checked', () => {
  let sb: Sandbox;
  let red: string;
  let blue: string;

  beforeAll(() => {
    sb = createSandbox('timeline-transitions');
    red = sb.path('red.mp4');
    blue = sb.path('blue.mp4');
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
  });
  afterAll(() => sb.cleanup());

  /**
   * Red 0-2.5 s, then blue 2.5-4.5 s. Blue is first placed at 2-4.5 with its media from 0,
   * then trimmed so that its first half second of media lies before its start (a handle).
   * Red is extended last, so the two never overlap while they are set up.
   */
  async function twoClips(name: string): Promise<{ id: string; left: string; right: string }> {
    const id = await createProject(sb, name, ['--width', '320', '--height', '240']);
    const left = await addClip(sb, id, { track: 'track-v1', start: 0, duration: 2, asset: red });
    const right = await addClip(sb, id, {
      track: 'track-v1',
      start: 2,
      duration: 2.5,
      asset: blue,
    });
    const trimmed = await sb.run([
      'timeline',
      'trim',
      '--project',
      id,
      '--clip',
      right.id,
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
      left.id,
      '--end',
      '2.5',
      '--json',
    ]);
    expect(extended.code, describeRun(extended)).toBe(0);
    return { id, left: left.id, right: right.id };
  }

  const addTransition = (id: string, args: string[]): Promise<RunResult> =>
    sb.run(['timeline', 'add-transition', '--project', id, ...args, '--json']);

  it('a dissolve blends the two clips across the junction in the decoded output', async () => {
    const { id, left, right } = await twoClips('Dissolve');
    const added = await addTransition(id, ['--left', left, '--right', right, '--duration', '1']);
    expect(added.code, describeRun(added)).toBe(0);

    const out = sb.path('out-dissolve');
    const r = await sb.run(['render', '--project', id, '--out', out, '--json']);
    expect(r.code, describeRun(r)).toBe(0);
    const file = join(
      out,
      readdirSync(out).find((n) => n.endsWith('.mp4'))!,
    );

    const [beforeR, beforeG] = centreRgb(file, 1);
    expect(beforeR).toBeGreaterThan(150);
    expect(beforeG).toBeLessThan(80);

    const [midR, midG, midB] = centreRgb(file, 2.5);
    expect(midR).toBeGreaterThan(80);
    expect(midR).toBeLessThan(180);
    expect(midB).toBeGreaterThan(80);
    expect(midB).toBeLessThan(180);
    expect(midG).toBeLessThan(60);

    const [afterR, afterG, afterB] = centreRgb(file, 3.5);
    expect(afterB).toBeGreaterThan(150);
    expect(afterR).toBeLessThan(80);
    expect(afterG).toBeLessThan(80);
  });

  it('a transition between clips that do not touch is refused, and nothing is written', async () => {
    const id = await createProject(sb, 'Gap', ['--width', '320', '--height', '240']);
    const a = await addClip(sb, id, { track: 'track-v1', start: 0, duration: 2, asset: red });
    const b = await addClip(sb, id, { track: 'track-v1', start: 3, duration: 2, asset: blue });
    const before = await showProject(sb, id);
    const r = await addTransition(id, ['--left', a.id, '--right', b.id, '--duration', '0.5']);
    expect(r.code, describeRun(r)).toBe(1);
    expect(errorCode(r)).toBe('TRANSITION_INVALID');
    expect(await showProject(sb, id)).toEqual(before);
  });

  it('a transition longer than half the shorter clip is refused', async () => {
    const { id, left, right } = await twoClips('Too long');
    const r = await addTransition(id, ['--left', left, '--right', right, '--duration', '1.5']);
    expect(r.code, describeRun(r)).toBe(1);
    expect(errorCode(r)).toBe('TRANSITION_INVALID');
  });

  it('a transition with no media beyond the edge (no handle) is refused', async () => {
    const id = await createProject(sb, 'No handle', ['--width', '320', '--height', '240']);
    const a = await addClip(sb, id, { track: 'track-v1', start: 0, duration: 2.5, asset: red });
    // Blue starts at its very first frame, so there is nothing before its edge to blend from.
    const b = await addClip(sb, id, { track: 'track-v1', start: 2.5, duration: 2, asset: blue });
    const r = await addTransition(id, ['--left', a.id, '--right', b.id, '--duration', '1']);
    expect(r.code, describeRun(r)).toBe(1);
    expect(errorCode(r)).toBe('TRANSITION_INVALID');
  });

  it('a clip that is part of a transition cannot be moved, and nothing changes', async () => {
    const { id, left, right } = await twoClips('Pinned');
    expect(
      (await addTransition(id, ['--left', left, '--right', right, '--duration', '1'])).code,
    ).toBe(0);
    const before = await showProject(sb, id);
    const r = await sb.run([
      'timeline',
      'move',
      '--project',
      id,
      '--clip',
      right,
      '--start',
      '3',
      '--json',
    ]);
    expect(r.code, describeRun(r)).toBe(1);
    expect(errorCode(r)).toBe('TRANSITION_IN_USE');
    expect(await showProject(sb, id)).toEqual(before);
  });

  it('a transition of an unsupported type is a usage error', async () => {
    const { id, left, right } = await twoClips('Wipe');
    const r = await addTransition(id, [
      '--left',
      left,
      '--right',
      right,
      '--duration',
      '1',
      '--type',
      'wipe',
    ]);
    expect(r.code, describeRun(r)).toBe(2);
  });

  it('the transition is saved on the timeline and the project still loads', async () => {
    const { id, left, right } = await twoClips('Saved');
    expect(
      (await addTransition(id, ['--left', left, '--right', right, '--duration', '1'])).code,
    ).toBe(0);
    const show = await showProject(sb, id);
    expect(track(show, 'track-v1').clips.map((c) => c.id)).toEqual(
      expect.arrayContaining([left, right]),
    );
    // The saved project lists the transition on its root composition, as the schema requires.
    const exported = sb.path('saved-transition.json');
    expect((await sb.run(['project', 'export', id, '-o', exported])).code).toBe(0);
    const doc = JSON.parse(readFileSync(exported, 'utf8')) as {
      source: {
        rootCompositionId: string;
        compositions: Record<string, { transitions?: Array<Record<string, unknown>> }>;
      };
    };
    const transitions = doc.source.compositions[doc.source.rootCompositionId]!.transitions ?? [];
    expect(transitions).toMatchObject([
      {
        trackId: 'track-v1',
        leftClipId: left,
        rightClipId: right,
        type: 'dissolve',
        durationUs: 1_000_000,
      },
    ]);
  });
});
