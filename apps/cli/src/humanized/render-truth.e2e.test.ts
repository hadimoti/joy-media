/**
 * What a render says about itself must match what it produced: the manifest's
 * frame size and length, the per-clip frame counts in the event stream, the
 * project's reported length, and a failure (not a silent success) when there is
 * nothing to encode. Real binary, real ffmpeg, fixtures generated in the sandbox.
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

interface ManifestDoc {
  media?: { width: number; height: number; durationUs: number };
  spec: { width: number; height: number };
  composition: { durationUs: number };
  clips: Array<{ clipId: string; frames: number }>;
}

interface ClipEvent {
  type: 'clip';
  clipId: string;
  framesRendered: number;
  totalFrames: number;
}

function manifestIn(dir: string): ManifestDoc {
  const file = readdirSync(dir).find((name) => name.endsWith('.manifest.json'));
  if (!file) throw new Error(`no manifest in ${dir}`);
  return JSON.parse(readFileSync(join(dir, file), 'utf8')) as ManifestDoc;
}

describe.skipIf(!hasMediaTools())('a render reports what it really produced', () => {
  let sb: Sandbox;
  let video: string;

  beforeAll(() => {
    sb = createSandbox('render-truth');
    video = sb.path('wide.mp4');
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=640x360:rate=30:duration=4',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=4',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      video,
    ]);
  });
  afterAll(() => sb.cleanup());

  it('an empty project is a failed real render, with nothing written', async () => {
    const id = await createProject(sb, 'Empty render');
    const out = sb.path('out-empty');
    const r: RunResult = await sb.run(['render', '--project', id, '--out', out, '--json']);
    expect(r.code, describeRun(r)).toBe(1);
    const errors = r.ndjson<{ type: string; code?: string }>().filter((e) => e.type === 'error');
    expect(errors.map((e) => e.code)).toEqual(['nothing-to-render']);
  });

  it('an empty project still answers a plan-only request with exit 0', async () => {
    const id = await createProject(sb, 'Empty plan');
    const r = await sb.run([
      'render',
      '--project',
      id,
      '--out',
      sb.path('out-plan'),
      '--manifest-only',
      '--json',
    ]);
    expect(r.code, describeRun(r)).toBe(0);
  });

  it('the manifest carries the real frame size and the content length, not the preset or declared length', async () => {
    // A 640x360 project, so the output size is the one this test is about.
    const id = await createProject(sb, 'Truth manifest', ['--width', '640', '--height', '360']);
    await addClip(sb, id, { track: 'track-v1', duration: 4, asset: video });
    await addClip(sb, id, { track: 'track-v1', start: 5, duration: 3, asset: video });
    const out = sb.path('out-truth');
    const r = await sb.run(['render', '--project', id, '--out', out, '--json']);
    expect(r.code, describeRun(r)).toBe(0);
    const manifest = manifestIn(out);
    expect(manifest.spec.width).toBe(640);
    expect(manifest.spec.height).toBe(360);
    expect(manifest.composition.durationUs).toBe(8_000_000);
    expect(manifest.media?.width).toBe(640);
    expect(manifest.media?.durationUs).toBe(8_000_000);
  });

  it('each clip event reports how far the timeline has rendered, out of the whole timeline', async () => {
    const id = await createProject(sb, 'Per clip', ['--width', '640', '--height', '360']);
    const first = await addClip(sb, id, { track: 'track-v1', duration: 4, asset: video });
    const second = await addClip(sb, id, {
      track: 'track-v1',
      start: 5,
      duration: 3,
      asset: video,
    });
    const r = await sb.run(['render', '--project', id, '--out', sb.path('out-per-clip'), '--json']);
    expect(r.code, describeRun(r)).toBe(0);
    const events = r
      .ndjson<ClipEvent | { type: string }>()
      .filter((e): e is ClipEvent => e.type === 'clip');
    const byClip = new Map(events.map((e) => [e.clipId, e]));
    // Timeline frames: the first clip covers 0-120, the second 150-240 (a 2 s gap at 4-5 s).
    expect(byClip.get(first.id)).toMatchObject({ framesRendered: 120, totalFrames: 240 });
    expect(byClip.get(second.id)).toMatchObject({ framesRendered: 240, totalFrames: 240 });
  });

  it('project show reports the content length even when the declared length is shorter', async () => {
    const id = await createProject(sb, 'Show length');
    // A plain label has no source length, so the clip may run past the 4 s fixture.
    await addClip(sb, id, { track: 'track-v1', start: 20, duration: 99, asset: 'long-label' });
    const show = await showProject(sb, id);
    expect(show.durationUs).toBe(119_000_000);
  });
});
