/**
 * Humanized end-to-end scenarios for `joy-media render` and `joy-media benchmark`.
 *
 * Every test runs the REAL built binary in a throw-away HOME and asserts only what
 * a person (or an AI agent in a tool loop) can observe: exit code, stdout, stderr
 * and files on disk. No wall-clock thresholds, no network, no API keys.
 *
 * Product facts these tests pin down (see the report that came with them):
 *  - Real media is encoded by `render-real.e2e.test.ts`; this suite builds label-only projects and
 *    guards the honest manifest-only behavior (`mediaProduced: false`).
 *  - Tests wrapped in `it.fails(...)` document real bugs that live in files this
 *    suite's owner may not edit (cli.ts, utils/*). They flip to red the moment the
 *    bug is fixed, which is the cue to turn them into plain `it(...)`.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSandbox, describeRun, hasAnsi, type Sandbox } from './harness.js';
import {
  buildProjectViaCli,
  eventsOfType,
  expectedFrames,
  expectNdjsonContract,
  isDirectory,
  listTree,
  projectDoc,
  readManifest,
  runAndSignalAfterOutput,
  runWithOpenStdin,
  stableEvents,
  stableManifest,
  writeSandboxFile,
  type BuiltProject,
  type DocClip,
  type RenderEventLine,
} from './render-helpers.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });

let sb: Sandbox;
/** A 3-clip reel built through the real CLI: 2.5 s + 1 s on Video 1, 0.5 s on Video 2. */
let reel: BuiltProject;
/** A project that exists in the store but has no clips. */
let blank: BuiltProject;

beforeAll(async () => {
  sb = createSandbox('render-bench');
  // The CLI's Windows default lives below APPDATA; create the platform config
  // directory as a user's first-launch setup would before project creation.
  mkdirSync(join(sb.home, 'AppData', 'Roaming', '@joy-media', 'desktop'), {
    recursive: true,
  });
  reel = await buildProjectViaCli(sb, 'Summer Reel', [
    { durationSec: 2.5 },
    { durationSec: 1, startSec: 2.5 },
    { durationSec: 0.5, track: 'track-v2' },
  ]);
  blank = await buildProjectViaCli(sb, 'Blank Canvas');
});
afterAll(() => sb.cleanup());

const manifestName = (id: string, ext = 'mp4'): string => `${id}.${ext}.manifest.json`;
const nodeSqliteWarning = /ExperimentalWarning|--trace-warnings/;
const tempOverrides = (path: string): Record<string, string> => ({
  TMPDIR: path,
  TMP: path,
  TEMP: path,
});

/** Render a hand-written project document and return what a user would see. */
async function renderDoc(
  name: string,
  doc: unknown,
  out: string,
  extraArgs: readonly string[] = [],
  options: { timeoutMs?: number } = {},
) {
  const file = writeSandboxFile(sb, name, doc);
  return sb.run(['render', '--project', file, '--out', out, '--json', ...extraArgs], options);
}

// ===========================================================================
// 1. The headline: render must not pretend it produced a video
// ===========================================================================

describe('a creator renders a finished timeline', () => {
  it('is told plainly that only a manifest was written and no video file exists', async () => {
    const r = await sb.run(['render', '--project', reel.id, '--out', 'honest']);
    expect(r.code, describeRun(r)).toBe(0);
    expect(r.out).toMatch(/manifest only/i);
    expect(r.out).toMatch(/no video/i);
    // Never claim a finished render, and never print a media path that does not exist.
    expect(r.out).not.toMatch(/\bRendered\b/);
    expect(r.out).not.toMatch(/\.(mp4|webm|mov)(?!\.manifest\.json)/);
    // ...and the disk agrees: the manifest is the only thing in the folder.
    expect(listTree(sb.path('honest'))).toEqual([manifestName(reel.id)]);
  });

  it('gets a manifest that itself says it is not a render', async () => {
    const r = await sb.run(['render', '--project', reel.id, '--out', 'honest-manifest', '--json']);
    expect(r.code, describeRun(r)).toBe(0);
    const manifest = readManifest(sb.path('honest-manifest', manifestName(reel.id)));
    expect(manifest.format).toBe('joy-media-render-manifest');
    expect(manifest.mediaProduced).toBe(false);
    expect(manifest.mediaFile).toBeNull();
    expect(manifest.note).toMatch(/manifest only/i);
  });

  it('lets an AI agent tail the --json stream until it ends with an honest `complete`', async () => {
    const r = await sb.run(['render', '--project', reel.id, '--out', 'agent-tail', '--json']);
    const events = expectNdjsonContract(r, ['complete']);
    const complete = events[events.length - 1]!;
    expect(complete['mediaProduced']).toBe(false);
    expect(complete['manifestWritten']).toBe(true);
    expect(String(complete['message'])).toMatch(/manifest only/i);
    expect(complete['warnings']).toEqual([]);
    expect(existsSync(resolve(sb.cwd, String(complete['artifactPath'])))).toBe(true);
    // Existing documented fields are all still there.
    for (const field of ['projectId', 'preset', 'outDir', 'artifactPath', 'totalFrames', 'ts']) {
      expect(complete, `complete.${field}`).toHaveProperty(field);
    }
    expect(typeof complete['durationMs']).toBe('number');
  });

  it('sees start, one track event per used track, one clip event per clip, then complete', async () => {
    const r = await sb.run(['render', '--project', reel.id, '--out', 'agent-events', '--json']);
    const events = expectNdjsonContract(r, ['complete']);
    expect(events.map((e) => e.type)).toEqual([
      'start',
      'track',
      'track',
      'clip',
      'clip',
      'clip',
      'complete',
    ]);

    const start = events[0]!;
    expect(start).toMatchObject({
      projectId: reel.id,
      title: 'Summer Reel',
      preset: 'mp4',
      totalFrames: 120,
      totalClips: 3,
      concurrency: 2,
    });

    // The empty Audio 1 track is not announced; the two used ones are, in timeline order.
    expect(eventsOfType(events, 'track')).toMatchObject([
      { trackId: 'track-v1', trackName: 'Video 1', clipCount: 2 },
      { trackId: 'track-v2', trackName: 'Video 2', clipCount: 1 },
    ]);

    const clips = eventsOfType(events, 'clip');
    expect(clips.map((e) => e['clipId'])).toEqual(reel.clips.map((c) => c.id));
    const progress = clips.map((e) => Number(e['framesRendered']));
    expect(progress).toEqual([75, 105, 120]);
    for (const clip of clips) expect(clip['progress']).toBe(1);
  });

  it('gets a manifest that matches the timeline they built, clip by clip', async () => {
    const r = await sb.run(['render', '--project', reel.id, '--out', 'match-timeline', '--json']);
    expect(r.code, describeRun(r)).toBe(0);
    const manifest = readManifest(sb.path('match-timeline', manifestName(reel.id)));

    expect(manifest).toMatchObject({
      schemaVersion: 1,
      projectId: reel.id,
      projectTitle: 'Summer Reel',
      preset: 'mp4',
      totalClips: 3,
      totalFrames: 120,
    });
    expect(manifest.spec).toMatchObject({
      container: 'mp4',
      videoCodec: 'h264',
      audioCodec: 'aac',
      width: 1080,
      height: 1920,
      fps: 30,
      extension: 'mp4',
    });
    expect(manifest.composition).toMatchObject({ id: 'root', width: 1080, height: 1920, fps: 30 });
    expect(manifest.warnings).toEqual([]);
    expect(Number.isNaN(Date.parse(manifest.renderedAt))).toBe(false);

    expect(manifest.clips).toHaveLength(reel.clips.length);
    manifest.clips.forEach((entry, i) => {
      const built = reel.clips[i]!;
      const durationUs = Math.round(built.durationSec * 1_000_000);
      expect(entry.clipId).toBe(built.id);
      expect(entry.trackId).toBe(built.track);
      expect(entry.durationUs).toBe(durationUs);
      expect(entry.startUs).toBe(Math.round((built.startSec ?? 0) * 1_000_000));
      expect(entry.frames).toBe(expectedFrames(durationUs));
    });
  });

  it('gets frame ranges that are contiguous, never overlap and add up to totalFrames', async () => {
    const r = await sb.run(['render', '--project', reel.id, '--out', 'ranges', '--json']);
    expect(r.code, describeRun(r)).toBe(0);
    const manifest = readManifest(sb.path('ranges', manifestName(reel.id)));
    let expectedFirst = 0;
    for (const clip of manifest.clips) {
      expect(clip.frameRange.first).toBe(expectedFirst);
      expect(clip.frameRange.last - clip.frameRange.first + 1).toBe(clip.frames);
      expectedFirst = clip.frameRange.last + 1;
    }
    expect(expectedFirst).toBe(manifest.totalFrames);
    expect(manifest.totalFrames).toBe(manifest.clips.reduce((sum, c) => sum + c.frames, 0));
  });

  for (const [preset, ext, container, video, audio] of [
    ['mp4', 'mp4', 'mp4', 'h264', 'aac'],
    ['webm', 'webm', 'webm', 'vp9', 'opus'],
    ['prores', 'mov', 'mov', 'prores-ks', 'pcm-s24le'],
  ] as const) {
    it(`renders the ${preset} preset into a .${ext} manifest with the right codecs`, async () => {
      const out = `preset-${preset}`;
      const r = await sb.run([
        'render',
        '--project',
        reel.id,
        '--preset',
        preset,
        '--out',
        out,
        '--json',
      ]);
      const events = expectNdjsonContract(r, ['complete']);
      expect(events[0]).toMatchObject({ type: 'start', preset });
      expect(listTree(sb.path(out))).toEqual([manifestName(reel.id, ext)]);
      const manifest = readManifest(sb.path(out, manifestName(reel.id, ext)));
      expect(manifest.preset).toBe(preset);
      expect(manifest.spec).toMatchObject({ container, videoCodec: video, audioCodec: audio });
    });
  }

  it('can type the preset in capitals (MP4) and still get an mp4', async () => {
    const r = await sb.run([
      'render',
      '--project',
      reel.id,
      '--preset',
      'MP4',
      '--out',
      'caps',
      '--json',
    ]);
    const events = expectNdjsonContract(r, ['complete']);
    expect(events[0]).toMatchObject({ preset: 'mp4' });
  });

  it('is stopped with a usage error (exit 2) when the preset does not exist, and nothing is written', async () => {
    const r = await sb.run([
      'render',
      '--project',
      reel.id,
      '--preset',
      'avi',
      '--out',
      'bad-preset',
      '--json',
    ]);
    expect(r.code, describeRun(r)).toBe(2);
    const events = expectNdjsonContract(r, ['error']);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', code: 'usage' });
    expect(String(events[0]!['message'])).toMatch(/avi/);
    expect(String(events[0]!['message'])).toMatch(/mp4, webm, prores/);
    expect(r.err).toMatch(/Unknown render preset "avi"/);
    expect(existsSync(sb.path('bad-preset'))).toBe(false);
  });
});

// ===========================================================================
// 2. Where the output goes
// ===========================================================================

describe('a creator chooses where the output goes', () => {
  it('renders into a folder that does not exist yet, creating every level', async () => {
    const r = await sb.run(['render', '--project', reel.id, '--out', 'deep/new/folder', '--json']);
    expect(r.code, describeRun(r)).toBe(0);
    expect(isDirectory(sb.path('deep', 'new', 'folder'))).toBe(true);
    expect(listTree(sb.path('deep'))).toEqual([`new/folder/${manifestName(reel.id)}`]);
  });

  it('falls back to ./renders in the current folder when --out is omitted', async () => {
    const r = await sb.run(['render', '--project', reel.id, '--json']);
    const events = expectNdjsonContract(r, ['complete']);
    expect(events[0]).toMatchObject({ outDir: './renders' });
    expect(existsSync(sb.path('renders', manifestName(reel.id)))).toBe(true);
  });

  it('can render straight into the current folder with --out .', async () => {
    const cwd = sb.path('here');
    mkdirSync(cwd, { recursive: true });
    const r = await sb.run(['render', '--project', reel.id, '--out', '.', '--json'], { cwd });
    expect(r.code, describeRun(r)).toBe(0);
    expect(listTree(cwd)).toEqual([manifestName(reel.id)]);
  });

  it('is refused up front when --out is an existing file, before any work is announced', async () => {
    const precious = writeSandboxFile(sb, 'precious.txt', 'do not touch');
    const r = await sb.run(['render', '--project', reel.id, '--out', precious, '--json']);
    expect(r.code, describeRun(r)).toBe(1);
    const events = expectNdjsonContract(r, ['error']);
    // Fail fast: no `start`, no clip events for work that could never be saved.
    expect(events.map((e) => e.type)).toEqual(['error']);
    expect(events[0]).toMatchObject({ code: 'output' });
    expect(String(events[0]!['message'])).toMatch(/not a directory/i);
    expect(readFileSync(precious, 'utf8')).toBe('do not touch');
  });

  it('is refused up front when --out sits underneath a file', async () => {
    const blocker = writeSandboxFile(sb, 'blocker.txt', 'i am a file');
    const r = await sb.run(['render', '--project', reel.id, '--out', `${blocker}/sub`, '--json']);
    expect(r.code, describeRun(r)).toBe(1);
    const events = expectNdjsonContract(r, ['error']);
    expect(events.map((e) => e.type)).toEqual(['error']);
    expect(events[0]).toMatchObject({ code: 'output' });
    expect(readFileSync(blocker, 'utf8')).toBe('i am a file');
  });

  it('gets a usage error (exit 2) for an empty --out instead of a cryptic mkdir failure', async () => {
    const r = await sb.run(['render', '--project', reel.id, '--out', '', '--json']);
    expect(r.code, describeRun(r)).toBe(2);
    const events = expectNdjsonContract(r, ['error']);
    expect(events[0]).toMatchObject({ code: 'usage' });
    expect(String(events[0]!['message'])).toMatch(/--out/);
  });

  it('overwrites a stale manifest from an earlier render with a fresh, valid one', async () => {
    const dir = sb.path('overwrite');
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, manifestName(reel.id)), '{"stale": true', 'utf8'); // truncated junk
    const r = await sb.run(['render', '--project', reel.id, '--out', 'overwrite', '--json']);
    expect(r.code, describeRun(r)).toBe(0);
    const manifest = readManifest(resolve(dir, manifestName(reel.id)));
    expect(manifest.projectId).toBe(reel.id);
    expect(listTree(dir)).toEqual([manifestName(reel.id)]); // no temp files left behind
  });

  it('keeps an earlier good manifest untouched when the new render fails', async () => {
    const first = await sb.run(['render', '--project', reel.id, '--out', 'keep-good', '--json']);
    expect(first.code, describeRun(first)).toBe(0);
    const path = sb.path('keep-good', manifestName(reel.id));
    const before = readFileSync(path, 'utf8');

    // Same id, but the timeline is now corrupt: the render must fail and leave `before` alone.
    const broken = projectDoc({
      id: reel.id,
      tracks: [{ id: 't1', clips: [{ id: 'bad', durationUs: -1 }] }],
    });
    const r = await renderDoc('keep-good.json', broken, 'keep-good');
    expect(r.code, describeRun(r)).toBe(1);
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(listTree(sb.path('keep-good'))).toEqual([manifestName(reel.id)]);
  });

  it('does not leave a half-written artifact when the manifest path is blocked by a folder', async () => {
    const blockedPath = sb.path('blocked', manifestName(reel.id));
    mkdirSync(blockedPath, { recursive: true });
    writeFileSync(resolve(blockedPath, 'keep.txt'), 'x', 'utf8');
    const r = await sb.run(['render', '--project', reel.id, '--out', 'blocked', '--json']);
    expect(r.code, describeRun(r)).toBe(1);
    const events = expectNdjsonContract(r, ['error']);
    expect(events[events.length - 1]).toMatchObject({ code: 'output' });
    expect(listTree(sb.path('blocked'))).toEqual([`${manifestName(reel.id)}/keep.txt`]);
  });

  it('survives two renders of the same project into the same folder at the same time', async () => {
    const [a, b] = await Promise.all([
      sb.run(['render', '--project', reel.id, '--out', 'race', '--json']),
      sb.run(['render', '--project', reel.id, '--out', 'race', '--json']),
    ]);
    expect(a.code, describeRun(a)).toBe(0);
    expect(b.code, describeRun(b)).toBe(0);
    expectNdjsonContract(a, ['complete']);
    expectNdjsonContract(b, ['complete']);
    // Whoever wrote last, the folder holds exactly one complete, parseable manifest.
    expect(listTree(sb.path('race'))).toEqual([manifestName(reel.id)]);
    const manifest = readManifest(sb.path('race', manifestName(reel.id)));
    expect(manifest.totalFrames).toBe(120);
    expect(manifest.clips).toHaveLength(3);
  });

  it('produces the same plan every time: rendering twice only differs in timestamps', async () => {
    const first = await sb.run(['render', '--project', reel.id, '--out', 'again', '--json']);
    const manifestA = readManifest(sb.path('again', manifestName(reel.id)));
    const second = await sb.run(['render', '--project', reel.id, '--out', 'again', '--json']);
    const manifestB = readManifest(sb.path('again', manifestName(reel.id)));
    expect(stableManifest(manifestB)).toEqual(stableManifest(manifestA));
    expect(stableEvents(expectNdjsonContract(second, ['complete']))).toEqual(
      stableEvents(expectNdjsonContract(first, ['complete'])),
    );
  });

  it('behaves the same through the single-file bundle as through the bin shim', async () => {
    const viaBin = await sb.run(['render', '--project', reel.id, '--out', 'parity', '--json']);
    const viaBundle = await sb.run(['render', '--project', reel.id, '--out', 'parity', '--json'], {
      entry: 'bundle',
    });
    expect(viaBundle.code, describeRun(viaBundle)).toBe(0);
    expect(stableEvents(expectNdjsonContract(viaBundle, ['complete']))).toEqual(
      stableEvents(expectNdjsonContract(viaBin, ['complete'])),
    );
  });
});

// ===========================================================================
// 3. Which project, and what is in it
// ===========================================================================

describe('a creator or agent points render at a project', () => {
  it('is told the render of an empty project did nothing, instead of being congratulated', async () => {
    const r = await sb.run(['render', '--project', blank.id, '--out', 'empty-human']);
    expect(r.code, describeRun(r)).toBe(0); // existing, deliberate behaviour: an empty timeline is not a failure
    expect(r.out).toMatch(/nothing rendered/i);
    expect(r.out).toMatch(/no manifest/i);
    expect(r.out).not.toMatch(/\bRendered\b/);
    expect(r.out).not.toMatch(/Wrote render manifest/);
    expect(existsSync(sb.path('empty-human'))).toBe(false);
  });

  it('gets an unmistakable `complete` for an empty project over --json: nothing written, nothing produced', async () => {
    const r = await sb.run(['render', '--project', blank.id, '--out', 'empty-json', '--json']);
    const events = expectNdjsonContract(r, ['complete']);
    expect(events.map((e) => e.type)).toEqual(['start', 'complete']);
    const complete = events[1]!;
    expect(complete).toMatchObject({
      artifactPath: '',
      totalFrames: 0,
      mediaProduced: false,
      manifestWritten: false,
    });
    expect(String(complete['message'])).toMatch(/nothing rendered/i);
    expect((complete['warnings'] as string[]).join(' ')).toMatch(/no clips/i);
    expect(existsSync(sb.path('empty-json'))).toBe(false);
  });

  it('is told to name a project when --project is forgotten (exit 1, kept as is), with a JSON error for agents', async () => {
    const human = await sb.run(['render']);
    expect(human.code, describeRun(human)).toBe(1);
    expect(human.out).toBe('');
    expect(human.err).toMatch(/--project/);

    const json = await sb.run(['render', '--json']);
    expect(json.code, describeRun(json)).toBe(1);
    const events = expectNdjsonContract(json, ['error']);
    expect(events[0]).toMatchObject({ code: 'usage' });
    expect(String(events[0]!['message'])).toMatch(/--project/);
  });

  it('is told which project could not be found, in the stream and on stderr', async () => {
    const r = await sb.run(['render', '--project', 'proj-nope', '--json']);
    expect(r.code, describeRun(r)).toBe(1);
    const events = expectNdjsonContract(r, ['error']);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ code: 'project-load', projectId: 'proj-nope' });
    expect(String(events[0]!['message'])).toMatch(/proj-nope/);
    expect(r.err).toMatch(/proj-nope/);
  });

  it('renders a project exported to a .json file, the way an agent hands a project over', async () => {
    const exported = await sb.run(['project', 'export', reel.id, '--output', 'handover.json']);
    expect(exported.code, describeRun(exported)).toBe(0);
    const r = await sb.run([
      'render',
      '--project',
      'handover.json',
      '--out',
      'from-file',
      '--json',
    ]);
    const events = expectNdjsonContract(r, ['complete']);
    expect(events[0]).toMatchObject({ projectId: reel.id, totalFrames: 120, totalClips: 3 });
  });

  it('gets a clear error and no files for every kind of broken project file', async () => {
    const broken: Array<[string, unknown, RegExp]> = [
      ['not-json.json', 'this is not json', /./],
      ['truncated.json', '{"id":"p","title":', /./],
      ['json-null.json', 'null', /./],
      ['json-array.json', '[]', /JOY Media project/],
      [
        'no-compositions.json',
        { id: 'p-1', title: 'x', rootCompositionId: 'root' },
        /compositions/,
      ],
      [
        'bad-root.json',
        projectDoc({ id: 'p-2', rootCompositionId: 'missing-root' }),
        /not a JOY Media project file/,
      ],
      ['no-id.json', projectDoc({ omitId: true }), /project with id/],
    ];
    const results = await Promise.all(
      broken.map(([name, doc], i) => renderDoc(name, doc, `broken-${i}`)),
    );
    results.forEach((r, i) => {
      const [name, , message] = broken[i]!;
      expect(r.code, `${name}${describeRun(r)}`).toBe(1);
      const events = expectNdjsonContract(r, ['error']);
      expect(String(events[events.length - 1]!['message']), name).toMatch(message);
      expect(r.err, `${name} must not dump a stack trace`).not.toMatch(/\n\s+at \S+/);
      expect(existsSync(sb.path(`broken-${i}`)), `${name} must not create the output folder`).toBe(
        false,
      );
    });
  });

  it('refuses clips with impossible durations by naming the clip, and never hangs', async () => {
    const bad: Array<[string, unknown]> = [
      ['negative', -5],
      ['text', 'soon'],
      ['null', null],
      ['missing', undefined],
      ['over-24h', 86_400_000_001],
      ['absurd', 1e15],
    ];
    const results = await Promise.all(
      bad.map(([label, durationUs], i) =>
        renderDoc(
          `bad-duration-${label}.json`,
          projectDoc({ tracks: [{ id: 't1', clips: [{ id: `clip-${label}`, durationUs }] }] }),
          `bad-duration-${i}`,
          [],
          { timeoutMs: 15_000 },
        ),
      ),
    );
    results.forEach((r, i) => {
      const [label] = bad[i]!;
      expect(r.timedOut, `${label} hung${describeRun(r)}`).toBe(false);
      expect(r.code, `${label}${describeRun(r)}`).toBe(1);
      const events = expectNdjsonContract(r, ['error']);
      const message = String(events[events.length - 1]!['message']);
      expect(message, label).toContain(`clip-${label}`);
      expect(message, label).toMatch(/durationUs/);
      expect(existsSync(sb.path(`bad-duration-${i}`)), label).toBe(false);
    });
  });

  it('does not render a disabled track, and says it skipped it', async () => {
    const r = await renderDoc(
      'disabled-track.json',
      projectDoc({
        id: 'with-disabled',
        tracks: [
          { id: 'hidden', enabled: false, clips: [{ id: 'ghost', durationUs: 2_000_000 }] },
          { id: 'shown', clips: [{ id: 'real', durationUs: 1_000_000 }] },
        ],
      }),
      'disabled-out',
    );
    const events = expectNdjsonContract(r, ['complete']);
    expect(events[0]).toMatchObject({ totalClips: 1, totalFrames: 30 });
    expect(eventsOfType(events, 'clip').map((e) => e['clipId'])).toEqual(['real']);
    const manifest = readManifest(sb.path('disabled-out', manifestName('with-disabled')));
    expect(manifest.clips.map((c) => c.clipId)).toEqual(['real']);
    expect(manifest.warnings.join(' ')).toMatch(/disabled track "hidden"/);
  });

  it('gets the same frame count for the same duration every time (rounding, minimum one frame)', async () => {
    // [durationUs, frames at the preset\'s 30 fps]
    const table: Array<[number, number]> = [
      [1_000, 1], // 0.001 s: shorter than a frame still occupies one frame
      [16_666, 1],
      [16_667, 1],
      [33_333, 1],
      [50_000, 2], // exactly 1.5 frames rounds up
      [1_000_000, 30],
      [1_033_333, 31],
      [2_500_000, 75],
      [3_600_000_000, 108_000], // a one hour clip
    ];
    const clips: DocClip[] = table.map(([durationUs], i) => ({ id: `c${i}`, durationUs }));
    const r = await renderDoc(
      'frame-math.json',
      projectDoc({ id: 'frame-math', tracks: [{ id: 't1', clips }] }),
      'frame-math',
    );
    expectNdjsonContract(r, ['complete']);
    const manifest = readManifest(sb.path('frame-math', manifestName('frame-math')));
    expect(manifest.clips.map((c) => c.frames)).toEqual(table.map(([, frames]) => frames));
    expect(manifest.totalFrames).toBe(table.reduce((sum, [, frames]) => sum + frames, 0));
  });

  it('is warned when the project runs at another frame rate or shape than the preset, and the manifest records both', async () => {
    const cases: Array<[string, { num: number; den: number }, number, number, boolean]> = [
      ['24fps', { num: 24, den: 1 }, 1080, 1920, true],
      ['30fps', { num: 30, den: 1 }, 1080, 1920, false],
      ['59.94fps', { num: 60_000, den: 1_001 }, 1080, 1920, true],
      ['60fps', { num: 60, den: 1 }, 1080, 1920, true],
      ['landscape', { num: 30, den: 1 }, 1920, 1080, true],
    ];
    const results = await Promise.all(
      cases.map(([label, frameRate, width, height]) =>
        renderDoc(
          `shape-${label}.json`,
          projectDoc({
            id: `shape-${label}`,
            frameRate,
            width,
            height,
            tracks: [{ id: 't1', clips: [{ id: 'one-second', durationUs: 1_000_000 }] }],
          }),
          `shape-${label}`,
        ),
      ),
    );
    results.forEach((r, i) => {
      const [label, frameRate, width, height, warns] = cases[i]!;
      expectNdjsonContract(r, ['complete']);
      const manifest = readManifest(sb.path(`shape-${label}`, manifestName(`shape-${label}`)));
      // Today the preset's fixed 30 fps decides the frame count, whatever the project says...
      expect(manifest.clips[0]!.frames, label).toBe(30);
      // ...but the manifest records what the project actually was, and the user is told.
      expect(manifest.composition.width, label).toBe(width);
      expect(manifest.composition.height, label).toBe(height);
      expect(manifest.composition.fps, label).toBeCloseTo(frameRate.num / frameRate.den, 6);
      if (warns) expect(manifest.warnings.join(' '), label).toMatch(/fixed at 1080x1920 @ 30 fps/);
      else expect(manifest.warnings, label).toEqual([]);
    });
  });

  it('cannot be tricked by a project id into writing outside the output folder', async () => {
    const jail = sb.path('jail');
    mkdirSync(jail, { recursive: true });
    const r = await renderDoc(
      'hostile-id.json',
      projectDoc({
        id: '../../escape',
        tracks: [{ id: 't1', clips: [{ id: 'a', durationUs: 1_000_000 }] }],
      }),
      'jail/out',
    );
    const events = expectNdjsonContract(r, ['complete']);
    const complete = events[events.length - 1]!;
    const written = resolve(sb.cwd, String(complete['artifactPath']));
    expect(written.startsWith(resolve(sb.path('jail', 'out')) + sep), written).toBe(true);
    expect(listTree(jail)).toHaveLength(1);
    expect(listTree(jail)[0]!.startsWith('out/')).toBe(true);
    expect(existsSync(sb.path('escape.mp4.manifest.json'))).toBe(false);
    expect(readManifest(written).projectId).toBe('../../escape'); // traceability is kept
    expect(readManifest(written).warnings.join(' ')).toMatch(/not a safe file name/);
  });

  it('gets a plain file name even when the project id has spaces and punctuation', async () => {
    const r = await renderDoc(
      'odd-id.json',
      projectDoc({
        id: 'my project: v2?',
        tracks: [{ id: 't1', clips: [{ id: 'a', durationUs: 1_000_000 }] }],
      }),
      'odd-id',
    );
    expectNdjsonContract(r, ['complete']);
    expect(listTree(sb.path('odd-id'))).toEqual(['my_project__v2_.mp4.manifest.json']);
  });

  it('copes with a project of five thousand clips', async () => {
    const clips: DocClip[] = Array.from({ length: 5000 }, (_, i) => ({
      id: `c${i}`,
      startUs: i * 100_000,
      durationUs: 100_000,
    }));
    const r = await renderDoc(
      'many.json',
      projectDoc({ id: 'many', tracks: [{ id: 't1', clips }] }),
      'many',
      [],
      { timeoutMs: 25_000 },
    );
    const events = expectNdjsonContract(r, ['complete']);
    expect(eventsOfType(events, 'clip')).toHaveLength(5000);
    const manifest = readManifest(sb.path('many', manifestName('many')));
    expect(manifest.totalClips).toBe(5000);
    expect(manifest.totalFrames).toBe(15_000);
    let next = 0;
    for (const clip of manifest.clips) {
      expect(clip.frameRange.first).toBe(next);
      next = clip.frameRange.last + 1;
    }
    expect(next).toBe(15_000);
  });

  it('copes with a 24 hour clip without hanging (and does not stall the event loop forever)', async () => {
    const r = await renderDoc(
      'day-long.json',
      projectDoc({
        id: 'day-long',
        tracks: [{ id: 't1', clips: [{ id: 'all-day', durationUs: 86_400_000_000 }] }],
      }),
      'day-long',
      [],
      { timeoutMs: 25_000 },
    );
    const events = expectNdjsonContract(r, ['complete']);
    expect(events[0]).toMatchObject({ totalFrames: 2_592_000 });
  });
});

// ===========================================================================
// 4. --concurrency
// ===========================================================================

describe('a creator tunes --concurrency', () => {
  const clips: DocClip[] = Array.from({ length: 40 }, (_, i) => ({
    id: `c${i}`,
    durationUs: ((i % 7) + 1) * 100_000,
  }));
  const doc = projectDoc({
    id: 'pool',
    tracks: [
      { id: 'a', clips: clips.slice(0, 25) },
      { id: 'b', clips: clips.slice(25) },
    ],
  });

  it('accepts 1 and 32, reports the value back, and plans identically at every level', async () => {
    const levels = [1, 2, 8, 32];
    const results = await Promise.all(
      levels.map((n) =>
        renderDoc(`pool-${n}.json`, doc, `pool-${n}`, ['--concurrency', String(n)]),
      ),
    );
    const manifests = results.map((r, i) => {
      const events = expectNdjsonContract(r, ['complete']);
      expect(events[0], `concurrency ${levels[i]}`).toMatchObject({ concurrency: levels[i] });
      // progress counter only ever moves forward and ends at the total
      const frames = eventsOfType(events, 'clip').map((e) => Number(e['framesRendered']));
      expect([...frames].sort((x, y) => x - y)).toEqual(frames);
      expect(frames[frames.length - 1]).toBe(Number(events[0]!['totalFrames']));
      return readManifest(sb.path(`pool-${levels[i]}`, manifestName('pool')));
    });
    // Same project => same plan, no matter how many workers pulled clips off the queue.
    for (const manifest of manifests) {
      expect(stableManifest(manifest)).toEqual(stableManifest(manifests[0]!));
      let next = 0;
      for (const clip of manifest.clips) {
        expect(clip.frameRange.first).toBe(next);
        next = clip.frameRange.last + 1;
      }
      expect(next).toBe(manifest.totalFrames);
    }
  });

  for (const bad of ['0', '33', 'abc', '2.5', '-1']) {
    it(`is stopped with exit 2 and a message naming --concurrency for "${bad}"`, async () => {
      const r = await sb.run([
        'render',
        '--project',
        reel.id,
        '--out',
        `bad-conc`,
        '--concurrency',
        bad,
      ]);
      expect(r.code, describeRun(r)).toBe(2);
      expect(r.err).toMatch(/--concurrency/);
      expect(r.out).toBe('');
      expect(existsSync(sb.path('bad-conc'))).toBe(false);
    });
  }
});

// ===========================================================================
// 5. Process-level behaviour
// ===========================================================================

describe('render behaves like a well-mannered command line program', () => {
  it('does not spam a log file with progress-bar redraws when output is not a terminal', async () => {
    const r = await sb.run(['render', '--project', reel.id, '--out', 'no-tty']);
    expect(r.code, describeRun(r)).toBe(0);
    expect(r.stdout.includes('\r')).toBe(false);
    expect(hasAnsi(r.stdout)).toBe(false);
    expect(hasAnsi(r.stderr)).toBe(false);
    expect(r.stdout).not.toMatch(/[█░]{20,}/); // the 32-cell bar (the banner logo is only 6 wide)
    expect(r.stdout).not.toMatch(/\d+\/\d+ frames/);
  });

  it('keeps --json stdout to JSON only: no banner, no ANSI, no progress bar, quiet stderr on success', async () => {
    const r = await sb.run(['render', '--project', reel.id, '--out', 'pure-json', '--json']);
    expectNdjsonContract(r, ['complete']);
    expect(r.stdout).not.toMatch(/JOY MEDIA CLI/);
    const noise = r.err
      .split('\n')
      .filter((line) => line.trim() !== '' && !nodeSqliteWarning.test(line));
    expect(noise, `unexpected stderr on a successful run:\n${r.err}`).toEqual([]);
  });

  it('never waits for input on stdin', async () => {
    const r = await runWithOpenStdin(sb, [
      'render',
      '--project',
      reel.id,
      '--out',
      'stdin-open',
      '--json',
    ]);
    expect(r.outcome).toBe('exited');
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/"type":"complete"/);
  });
});

describe('Ctrl-C during a long render', () => {
  it.skipIf(process.platform === 'win32')(
    'ends the run with exit 130, a terminal `cancelled` error event and no manifest',
    async () => {
      const clips: DocClip[] = Array.from({ length: 1000 }, (_, i) => ({
        id: `day-${i}`,
        durationUs: 86_400_000_000,
      }));
      const file = writeSandboxFile(
        sb,
        'marathon-sigint.json',
        projectDoc({ id: 'marathon', tracks: [{ id: 't1', clips }] }),
      );
      const r = await runAndSignalAfterOutput(
        sb,
        ['render', '--project', file, '--out', 'marathon-out', '--json'],
        'SIGINT',
      );
      expect(r.timedOut, `a signal must interrupt the render${describeRun(r).slice(0, 600)}`).toBe(
        false,
      );
      expect(r.code, describeRun(r).slice(0, 600)).toBe(130);
      const events = expectNdjsonContract(r, ['error']);
      expect(events[events.length - 1]).toMatchObject({ code: 'cancelled' });
      expect(eventsOfType(events, 'complete')).toHaveLength(0);
      expect(listTree(sb.path('marathon-out'))).toEqual([]);
    },
  );
});

// ===========================================================================
// 6. Cross-area contracts covered here to keep the complete render workflow honest.
// ===========================================================================

describe('cross-area CLI contracts used by render and benchmark', () => {
  it('treats a forgotten value after --preset as a usage error instead of silently using mp4 [cli.ts]', async () => {
    const r = await sb.run(['render', '--project', reel.id, '--out', 'known-preset', '--preset']);
    expect(r.code, describeRun(r)).toBe(2);
  });

  it('rejects a misspelled flag (--prest webm) instead of silently ignoring it [cli.ts strict:false]', async () => {
    const r = await sb.run([
      'render',
      '--project',
      reel.id,
      '--out',
      'known-typo',
      '--prest',
      'webm',
    ]);
    expect(r.code, describeRun(r)).toBe(2);
  });

  it('rejects a misspelled benchmark flag (--sytem) instead of running everything [cli.ts strict:false]', async () => {
    const r = await sb.run(['benchmark', '--sytem', '--json']);
    expect(r.code, describeRun(r)).toBe(2);
  });

  it('ends the --json stream with an error event for an invalid --concurrency [cli.ts]', async () => {
    const r = await sb.run([
      'render',
      '--project',
      reel.id,
      '--out',
      'known-conc',
      '--concurrency',
      '99',
      '--json',
    ]);
    expect(r.code, describeRun(r)).toBe(2);
    expectNdjsonContract(r, ['error']);
  });

  it('describes the lower bound of --concurrency correctly (>= 1, not "> 1") [utils/flags.ts]', async () => {
    const r = await sb.run([
      'render',
      '--project',
      reel.id,
      '--out',
      'known-msg',
      '--concurrency',
      '0',
    ]);
    expect(r.code, describeRun(r)).toBe(2);
    expect(r.err).toMatch(/Invalid value for --concurrency: value must be >= 1 \(received: 0\)/);
  });

  it('finds a project by id even when a folder with the same name exists in the current directory [utils/project-loader.ts]', async () => {
    // Natural workflow: `render --project <id> --out <id>` creates ./<id>/, and the next
    // `render --project <id>` then tries to read that folder as a JSON file (EISDIR).
    const cwd = sb.path('shadow');
    mkdirSync(cwd, { recursive: true });
    const args = ['render', '--project', reel.id, '--out', reel.id, '--json'];
    const first = await sb.run(args, { cwd });
    expect(first.code, describeRun(first)).toBe(0);
    const second = await sb.run(args, { cwd });
    expect(second.code, describeRun(second)).toBe(0);
  });
});

// ===========================================================================
// 7. benchmark
// ===========================================================================

interface Measurement extends RenderEventLine {
  suite: string;
  name: string;
  unit: string;
  value: number;
  iterations: number;
  totalMs: number;
  perOpMs: number;
}
interface Summary extends RenderEventLine {
  suite: string;
  measurementCount: number;
  totalMs: number;
  measurements: Measurement[];
}

const BENCHMARK_SHAPE: Array<[string, string, string, number]> = [
  ['system', 'disk-read-4MiB', 'MB/sec', 64],
  ['system', 'disk-write-1MiB', 'MB/sec', 32],
  ['system', 'sqlite-tx-throughput', 'tx/sec', 5000],
  ['system', 'heap-allocation', 'allocs/sec', 50_000],
  ['media-engine', 'timeline-scrub', 'ops/sec', 599],
  ['media-engine', 'clip-collision-resolve', 'clips/sec', 100_000],
  ['media-engine', 'living-look-compile', 'compiles/sec', 500],
];

describe('an agent or creator benchmarks their machine', () => {
  let fullA: ReturnType<typeof expectNdjsonContract>;
  let fullB: ReturnType<typeof expectNdjsonContract>;

  beforeAll(async () => {
    const [a, b] = await Promise.all([
      sb.run(['benchmark', '--json']),
      sb.run(['benchmark', '--json']),
    ]);
    expect(a.code, describeRun(a)).toBe(0);
    expect(b.code, describeRun(b)).toBe(0); // two benchmarks at once must not trample each other
    fullA = expectNdjsonContract(a, ['complete']);
    fullB = expectNdjsonContract(b, ['complete']);
  });

  it('streams every measurement, then one summary per suite, then complete', () => {
    expect(fullA.map((e) => e.type)).toEqual([
      ...Array(7).fill('measurement'),
      'summary',
      'summary',
      'complete',
    ]);
    const complete = fullA[fullA.length - 1]!;
    expect(complete).toMatchObject({ suites: ['system', 'media-engine'], measurementCount: 7 });
  });

  it('reports a stable shape: the same metrics, units and iteration counts on every run', () => {
    const shape = (events: typeof fullA): unknown =>
      eventsOfType(events, 'measurement').map((m) => [
        m['suite'],
        m['name'],
        m['unit'],
        m['iterations'],
      ]);
    expect(shape(fullA)).toEqual(BENCHMARK_SHAPE);
    expect(shape(fullB)).toEqual(shape(fullA));
  });

  it('only ever reports real numbers: nothing is null, NaN or infinite once it has been through JSON', () => {
    for (const m of eventsOfType(fullA, 'measurement') as Measurement[]) {
      for (const field of ['value', 'iterations', 'totalMs', 'perOpMs'] as const) {
        expect(Number.isFinite(m[field]), `${m.name}.${field} = ${String(m[field])}`).toBe(true);
      }
      expect(m.value, m.name).toBeGreaterThan(0);
      expect(m.totalMs, m.name).toBeGreaterThanOrEqual(0);
      expect(m.perOpMs, m.name).toBeGreaterThanOrEqual(0);
    }
  });

  it('really compiles the Living Look instead of timing an instant rejection', () => {
    const look = (eventsOfType(fullA, 'measurement') as Measurement[]).find(
      (m) => m.name === 'living-look-compile',
    )!;
    expect(look['failures']).toBe(0);
  });

  it("times each suite separately: a suite total is its own time, not the whole run's", () => {
    const summaries = eventsOfType(fullA, 'summary') as Summary[];
    const complete = fullA[fullA.length - 1]!;
    const measurements = eventsOfType(fullA, 'measurement') as Measurement[];
    for (const summary of summaries) {
      const own = measurements.filter((m) => m.suite === summary.suite);
      expect(summary.measurementCount).toBe(own.length);
      // A summary repeats its suite's measurements (minus the per-event `type` tag).
      expect(summary.measurements).toEqual(own.map(({ type: _type, ...rest }) => rest));
      expect(summary.totalMs).toBeGreaterThanOrEqual(
        own.reduce((sum, m) => sum + m.totalMs, 0) - 0.01,
      );
      expect(summary.totalMs).toBeLessThanOrEqual(Number(complete['totalMs']) + 0.01);
    }
    // Two suites ran one after the other, so their times must add up to at most the whole run.
    const sumOfSuites = summaries.reduce((sum, s) => sum + s.totalMs, 0);
    expect(sumOfSuites).toBeLessThanOrEqual(Number(complete['totalMs']) + 0.01);
  });

  it('runs only the system suite for --system and only the engine suite for --media-engine', async () => {
    const [system, engine] = await Promise.all([
      sb.run(['benchmark', '--system', '--json']),
      sb.run(['benchmark', '--media-engine', '--json']),
    ]);
    const systemEvents = expectNdjsonContract(system, ['complete']);
    const engineEvents = expectNdjsonContract(engine, ['complete']);
    expect(eventsOfType(systemEvents, 'measurement').map((m) => m['name'])).toEqual(
      BENCHMARK_SHAPE.filter(([suite]) => suite === 'system').map(([, name]) => name),
    );
    expect(eventsOfType(engineEvents, 'measurement').map((m) => m['name'])).toEqual(
      BENCHMARK_SHAPE.filter(([suite]) => suite === 'media-engine').map(([, name]) => name),
    );
    expect(systemEvents[systemEvents.length - 1]).toMatchObject({ suites: ['system'] });
    expect(engineEvents[engineEvents.length - 1]).toMatchObject({ suites: ['media-engine'] });
  });

  it('prints readable tables without ANSI or redraws when piped', async () => {
    const r = await sb.run(['benchmark']);
    expect(r.code, describeRun(r)).toBe(0);
    expect(r.out).toContain('System Benchmarks');
    expect(r.out).toContain('Media Engine Benchmarks');
    for (const [, name] of BENCHMARK_SHAPE) expect(r.out).toContain(name);
    expect(r.out).toMatch(/Benchmark complete in \d+ms — 7 measurement\(s\)/);
    expect(hasAnsi(r.stdout)).toBe(false);
    expect(r.stdout.includes('\r')).toBe(false);
  });

  it('leaves nothing behind in the temp folder', async () => {
    const tmp = sb.path('bench-tmp');
    mkdirSync(tmp, { recursive: true });
    const r = await sb.run(['benchmark', '--system', '--json'], { env: tempOverrides(tmp) });
    expect(r.code, describeRun(r)).toBe(0);
    expect(readdirSync(tmp)).toEqual([]);
  });

  it('fails loudly (exit 1, error event) when the system suite cannot get a scratch folder, while the engine suite still works', async () => {
    const blocker = writeSandboxFile(sb, 'not-a-folder', 'x');
    const env = tempOverrides(join(blocker, 'scratch'));
    const system = await sb.run(['benchmark', '--system', '--json'], { env });
    expect(system.code, describeRun(system)).toBe(1);
    const events = expectNdjsonContract(system, ['error']);
    expect(String(events[events.length - 1]!['message'])).toMatch(/benchmark failed/i);

    const engine = await sb.run(['benchmark', '--media-engine', '--json'], { env });
    expect(engine.code, describeRun(engine)).toBe(0);
    expectNdjsonContract(engine, ['complete']);
  });

  it('never waits for input on stdin', async () => {
    const r = await runWithOpenStdin(sb, ['benchmark', '--media-engine', '--json']);
    expect(r.outcome).toBe('exited');
    expect(r.code).toBe(0);
  });
});
