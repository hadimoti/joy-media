/**
 * `timeline add-clip` checks the media it is given before it writes anything:
 * a path that is not there, audio on a visual track (or picture on an audio
 * track), and a clip longer than its source. Plain labels keep working.
 * Real binary and real ffmpeg; fixtures are generated inside the sandbox.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSandbox, describeRun, type RunResult, type Sandbox } from './harness.js';
import { createProject, showProject } from './project-helpers.js';

const hasMediaTools = (): boolean =>
  spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

function ffmpeg(args: string[]): void {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(' ')} failed: ${r.stderr}`);
}

function errorCode(r: RunResult): string {
  return (r.json() as { code: string }).code;
}

interface ExportedProject {
  source: {
    rootCompositionId: string;
    assets: Record<string, Record<string, unknown>>;
    compositions: Record<string, { tracks: Array<Record<string, unknown>> }>;
  };
}

function expectOkExport(r: RunResult): void {
  expect(r.code, describeRun(r)).toBe(0);
}

describe.skipIf(!hasMediaTools())('timeline add-clip checks its media before writing', () => {
  let sb: Sandbox;
  let video: string;
  let audio: string;
  let still: string;

  beforeAll(() => {
    sb = createSandbox('timeline-validation');
    video = sb.path('clip.mp4');
    audio = sb.path('music.wav');
    still = sb.path('still.png');
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x240:rate=30:duration=2',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=2',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      video,
    ]);
    ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=880:duration=3', audio]);
    ffmpeg(['-f', 'lavfi', '-i', 'color=c=blue:size=320x240', '-frames:v', '1', still]);
  });
  afterAll(() => sb.cleanup());

  /** A fresh project, exported, edited in place, and returned as a project file path. */
  async function editedProject(
    name: string,
    edit: (source: ExportedProject['source']) => void,
  ): Promise<string> {
    const id = await createProject(sb, name);
    const exported = sb.path(`${name.replace(/\s+/g, '-')}.json`);
    expectOkExport(await sb.run(['project', 'export', id, '-o', exported]));
    const doc = JSON.parse(readFileSync(exported, 'utf8')) as ExportedProject;
    edit(doc.source);
    writeFileSync(exported, JSON.stringify(doc, null, 2));
    return exported;
  }

  const addClip = (id: string, extra: string[]): Promise<RunResult> =>
    sb.run(['timeline', 'add-clip', '--project', id, ...extra, '--json']);

  it('a path that does not exist is an error, not a silent label', async () => {
    const id = await createProject(sb, 'Missing path');
    const before = await showProject(sb, id);
    const r = await addClip(id, ['--track', 'track-v1', '--asset', sb.path('nope.mp4')]);
    expect(r.code, describeRun(r)).toBe(1);
    expect(errorCode(r)).toBe('MEDIA_NOT_FOUND');
    expect(await showProject(sb, id)).toEqual(before);
  });

  it('a plain label without a path or media extension is still accepted', async () => {
    const id = await createProject(sb, 'Label');
    const r = await addClip(id, ['--track', 'track-v1', '--asset', 'intro']);
    expect(r.code, describeRun(r)).toBe(0);
  });

  it('audio-only media on a visual track is refused and nothing is written', async () => {
    const id = await createProject(sb, 'Audio on visual');
    const before = await showProject(sb, id);
    const r = await addClip(id, ['--track', 'track-v1', '--asset', audio]);
    expect(r.code, describeRun(r)).toBe(1);
    expect(errorCode(r)).toBe('TRACK_KIND_MISMATCH');
    expect(await showProject(sb, id)).toEqual(before);
  });

  it('media with picture on an audio track is refused and nothing is written', async () => {
    const id = await createProject(sb, 'Video on audio');
    const before = await showProject(sb, id);
    const r = await addClip(id, ['--track', 'track-a1', '--asset', video]);
    expect(r.code, describeRun(r)).toBe(1);
    expect(errorCode(r)).toBe('TRACK_KIND_MISMATCH');
    expect(await showProject(sb, id)).toEqual(before);
  });

  it('a clip longer than its source is refused, and the message names --allow-extend', async () => {
    const id = await createProject(sb, 'Too long');
    const before = await showProject(sb, id);
    const r = await addClip(id, ['--track', 'track-v1', '--asset', video, '--duration', '5']);
    expect(r.code, describeRun(r)).toBe(1);
    expect(errorCode(r)).toBe('CLIP_EXCEEDS_SOURCE');
    expect((r.json() as { message: string }).message).toContain('--allow-extend');
    expect(await showProject(sb, id)).toEqual(before);
  });

  it('--allow-extend accepts a clip longer than its source', async () => {
    const id = await createProject(sb, 'Allow extend');
    const r = await addClip(id, [
      '--track',
      'track-v1',
      '--asset',
      video,
      '--duration',
      '5',
      '--allow-extend',
    ]);
    expect(r.code, describeRun(r)).toBe(0);
  });

  it('a still image may be given any length on a visual track', async () => {
    const id = await createProject(sb, 'Still');
    const r = await addClip(id, ['--track', 'track-v1', '--asset', still, '--duration', '10']);
    expect(r.code, describeRun(r)).toBe(0);
  });

  it('without --duration a real file gets its own length', async () => {
    const id = await createProject(sb, 'Whole file');
    const r = await addClip(id, ['--track', 'track-v1', '--asset', video]);
    expect(r.code, describeRun(r)).toBe(0);
    const clipUs = (r.json() as { clip: { durationUs: number } }).clip.durationUs;
    expect(clipUs).toBeGreaterThan(1_900_000);
    expect(clipUs).toBeLessThan(2_100_000);
  });

  it('audio-only media on an audio track is accepted', async () => {
    const id = await createProject(sb, 'Audio on audio');
    const r = await addClip(id, ['--track', 'track-a1', '--asset', audio]);
    expect(r.code, describeRun(r)).toBe(0);
  });

  it('a missing file with an uncommon media extension is an error too', async () => {
    const id = await createProject(sb, 'Missing gif');
    const r = await addClip(id, ['--track', 'track-v1', '--asset', sb.path('missing.gif')]);
    expect(r.code, describeRun(r)).toBe(1);
    expect(errorCode(r)).toBe('MEDIA_NOT_FOUND');
  });

  it('a rejected add-clip does not record the file in the machine-local source registry', async () => {
    const id = await createProject(sb, 'Registry');
    const fresh = sb.path('fresh-only-for-registry.wav');
    copyFileSync(audio, fresh);
    const registry = join(sb.joyDir, 'cli-asset-sources.json');
    const r = await addClip(id, ['--track', 'track-v1', '--asset', fresh]);
    expect(r.code, describeRun(r)).toBe(1);
    expect(errorCode(r)).toBe('TRACK_KIND_MISMATCH');
    const recorded = existsSync(registry) ? readFileSync(registry, 'utf8') : '';
    expect(recorded).not.toContain('fresh-only-for-registry.wav');
  });

  it('a legacy track with kind audio and no family is still an audio track', async () => {
    const id = await createProject(sb, 'Legacy audio');
    const exported = sb.path('legacy.json');
    expectOkExport(await sb.run(['project', 'export', id, '-o', exported]));
    const doc = JSON.parse(readFileSync(exported, 'utf8')) as {
      source: {
        rootCompositionId: string;
        compositions: Record<string, { tracks: Array<Record<string, unknown>> }>;
      };
    };
    const root = doc.source.compositions[doc.source.rootCompositionId]!;
    const track = root.tracks.find((t) => t.id === 'track-a1')!;
    delete track.family;
    track.kind = 'audio';
    writeFileSync(exported, JSON.stringify(doc, null, 2));
    const r = await sb.run([
      'timeline',
      'add-clip',
      '--project',
      exported,
      '--track',
      'track-a1',
      '--asset',
      video,
      '--json',
    ]);
    expect(r.code, describeRun(r)).toBe(1);
    expect(errorCode(r)).toBe('TRACK_KIND_MISMATCH');
  });

  it('an asset id the project already knows is accepted with no file of that name on disk', async () => {
    const file = await editedProject('Known asset', (source) => {
      source.assets['intro.mp4'] = {
        id: 'intro.mp4',
        kind: 'video',
        displayName: 'intro.mp4',
        bytes: 1,
        descriptor: { mimeType: 'video/mp4', durationUs: 5_000_000 },
      };
    });
    const r = await sb.run([
      'timeline',
      'add-clip',
      '--project',
      file,
      '--track',
      'track-v1',
      '--asset',
      'intro.mp4',
      '--duration',
      '2',
      '--json',
    ]);
    expect(r.code, describeRun(r)).toBe(0);
  });

  it('a clip with no --asset is checked against the default asset it will reference', async () => {
    const file = await editedProject('Default audio', (source) => {
      source.assets['asset-default'] = {
        id: 'asset-default',
        kind: 'audio',
        displayName: 'asset-default',
        bytes: 1,
        descriptor: { mimeType: 'audio/wav', durationUs: 3_000_000 },
      };
    });
    const r = await sb.run([
      'timeline',
      'add-clip',
      '--project',
      file,
      '--track',
      'track-v1',
      '--json',
    ]);
    expect(r.code, describeRun(r)).toBe(1);
    expect(errorCode(r)).toBe('TRACK_KIND_MISMATCH');
  });

  it('--allow-extend is a usage error outside add-clip', async () => {
    const id = await createProject(sb, 'Usage');
    const r = await sb.run([
      'timeline',
      'trim',
      '--project',
      id,
      '--clip',
      'clip-none',
      '--start',
      '0',
      '--allow-extend',
    ]);
    expect(r.code, describeRun(r)).toBe(2);
  });
});
