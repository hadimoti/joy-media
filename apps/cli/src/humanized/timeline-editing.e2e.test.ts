/**
 * `joy-media timeline ...` as a creator cutting a video, and as an AI agent
 * scripting the same cuts. Real binary, throw-away HOME, state read back by a
 * second process.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSandbox, describeRun, hasAnsi, type Sandbox } from './harness.js';
import {
  addClip,
  createProject,
  defaultProjectDbPath,
  exportAndValidate,
  expectExit,
  expectOk,
  fingerprint,
  jsonError,
  listProjects,
  SEC,
  showProject,
  singleJson,
  spans,
  track,
} from './project-helpers.js';

vi.setConfig({ testTimeout: 60_000 });

let sb: Sandbox;
beforeEach(() => {
  sb = createSandbox('timeline');
});
afterEach(() => sb.cleanup());

interface SplitDoc {
  projectId: string;
  revision: number;
  changed: boolean;
  trackId: string;
  atUs: number;
  clips: Array<{ id: string; startUs: number; durationUs: number; sourceInUs: number | null }>;
}

async function split(
  project: string,
  clip: string,
  at: number | string,
  extra: readonly string[] = [],
): Promise<SplitDoc> {
  const r = expectOk(
    await sb.run([
      'timeline',
      'split',
      '--project',
      project,
      '--clip',
      clip,
      '--at',
      String(at),
      '--json',
      ...extra,
    ]),
  );
  return singleJson<SplitDoc>(r);
}

/** A project holding one 30 s clip on Video 1 - "the intro". */
async function introProject(): Promise<{ id: string; clip: string }> {
  const id = await createProject(sb, 'Intro');
  const clip = await addClip(sb, id, { duration: 30 });
  return { id, clip: clip.id };
}

describe('a creator cuts a 30 second intro', () => {
  it('splits it at 10 s and 20 s, trims the tail: the timeline shows three coherent clips', async () => {
    const id = await createProject(sb, 'Intro');
    const added = expectOk(
      await sb.run(['timeline', 'add-clip', '--project', id, '--duration', '30']),
    );
    expect(added.out).toMatch(/Added clip clip-\w+ to track Video 1 \(saved rev 2\)\./);
    let show = await showProject(sb, id);
    expect(show.revision).toBe(2);
    expect(spans(show)).toEqual([[0, 30]]);
    const first = track(show, 'track-v1').clips[0]!.id;

    const cut1 = await split(id, first, 10);
    expect(cut1.revision).toBe(3);
    const secondId = cut1.clips[1]!.id;

    const cut2 = await split(id, secondId, 20);
    expect(cut2.revision).toBe(4);
    const thirdId = cut2.clips[1]!.id;

    const trimmed = expectOk(
      await sb.run(['timeline', 'trim', '--project', id, '--clip', thirdId, '--end', '25']),
    );
    expect(trimmed.out).toMatch(/Trimmed clip .* \(saved rev 5\)\./);

    show = await showProject(sb, id);
    expect(show.revision).toBe(5);
    const clips = track(show, 'track-v1').clips;
    expect(clips.map((c) => c.id)).toEqual([first, secondId, thirdId]);
    expect(new Set(clips.map((c) => c.id)).size, 'clip ids are unique').toBe(3);
    expect(spans(show)).toEqual([
      [0, 10],
      [10, 20],
      [20, 25],
    ]);
    // Coherent: every clip starts exactly where the previous one ends, and the
    // untouched video keeps playing continuously from its source.
    for (let i = 1; i < clips.length; i += 1) {
      expect(clips[i]!.startUs).toBe(clips[i - 1]!.endUs);
      expect(clips[i]!.sourceInUs).toBe(clips[i]!.startUs);
    }

    // And a human looking at it sees the same three clips.
    const human = expectOk(await sb.run(['project', 'show', id]));
    expect(human.out).toMatch(/Video 1 \[visual\].*3 clip/);
    expect(human.out).toMatch(/0\.00s -> 10\.00s/);
    expect(human.out).toMatch(/20\.00s -> 25\.00s \(5\.00s\)/);
  });

  it('the second half of a split plays on from where the first half stopped', async () => {
    const { id, clip } = await introProject();
    const cut = await split(id, clip, 12.5);
    expect(cut.atUs).toBe(12_500_000);
    const [left, right] = cut.clips;
    expect(left).toMatchObject({ startUs: 0, durationUs: 12.5 * SEC, sourceInUs: 0 });
    expect(right).toMatchObject({
      startUs: 12.5 * SEC,
      durationUs: 17.5 * SEC,
      sourceInUs: 12.5 * SEC,
    });
    // ...and that is what is persisted, not just what was printed.
    const persisted = track(await showProject(sb, id), 'track-v1').clips;
    expect(persisted.map((c) => c.sourceInUs)).toEqual([0, 12.5 * SEC]);
  });

  it('splitting the same clip a second time keeps every clip id unique and addressable', async () => {
    const { id, clip } = await introProject();
    await split(id, clip, 10);
    await split(id, clip, 5);

    const show = await showProject(sb, id);
    const clips = track(show, 'track-v1').clips;
    expect(spans(show)).toEqual([
      [0, 5],
      [5, 10],
      [10, 30],
    ]);
    const ids = clips.map((c) => c.id);
    expect(new Set(ids).size, `duplicate clip ids: ${ids.join(', ')}`).toBe(3);

    // Each id really addresses exactly one clip: removing one leaves the other two.
    for (const remaining of [2, 1, 0]) {
      const current = track(await showProject(sb, id), 'track-v1').clips;
      expectOk(
        await sb.run(['timeline', 'remove-clip', '--project', id, '--clip', current[0]!.id]),
      );
      expect(track(await showProject(sb, id), 'track-v1').clips).toHaveLength(remaining);
    }
  });

  it('keeps the source continuous when a clip is split, then split again inside the second half', async () => {
    const { id, clip } = await introProject();
    const a = await split(id, clip, 10);
    const b = await split(id, a.clips[1]!.id, 22);
    expect(b.clips[1]).toMatchObject({ startUs: 22 * SEC, sourceInUs: 22 * SEC });
  });

  it.each([
    ['exactly at the end of the clip', '30'],
    ['past the end of the clip', '31'],
    ['far beyond the project', '3600'],
  ])('refuses to split %s: exit 1, nothing changes', async (_label, at) => {
    const { id, clip } = await introProject();
    const before = await fingerprint(sb, id);
    const r = expectExit(
      await sb.run(['timeline', 'split', '--project', id, '--clip', clip, '--at', at]),
      1,
    );
    expect(r.err).toMatch(/Split point .* outside clip range \[0s, 30s\]/);
    expect(r.out.trim()).toBe('');
    expect(await fingerprint(sb, id)).toBe(before);
  });

  it('refuses to split at the very start of a clip that does not begin at zero', async () => {
    const id = await createProject(sb, 'Offset');
    const c = await addClip(sb, id, { start: 5, duration: 10 });
    const before = await fingerprint(sb, id);
    expectExit(
      await sb.run(['timeline', 'split', '--project', id, '--clip', c.id, '--at', '5']),
      1,
    );
    expectExit(
      await sb.run(['timeline', 'split', '--project', id, '--clip', c.id, '--at', '2']),
      1,
    );
    expect(await fingerprint(sb, id)).toBe(before);
  });

  it('trims the tail with --end, or with --duration, leaving the start alone', async () => {
    const { id, clip } = await introProject();
    expectOk(await sb.run(['timeline', 'trim', '--project', id, '--clip', clip, '--end', '20']));
    expect(spans(await showProject(sb, id))).toEqual([[0, 20]]);

    expectOk(
      await sb.run(['timeline', 'trim', '--project', id, '--clip', clip, '--duration', '15']),
    );
    expect(spans(await showProject(sb, id))).toEqual([[0, 15]]);
  });

  it('sets both edges with --start and --end', async () => {
    const { id, clip } = await introProject();
    const r = expectOk(
      await sb.run([
        'timeline',
        'trim',
        '--project',
        id,
        '--clip',
        clip,
        '--start',
        '2',
        '--end',
        '12',
        '--json',
      ]),
    );
    const doc = singleJson<{
      changed: boolean;
      clip: { startUs: number; durationUs: number; sourceInUs: number | null };
    }>(r);
    expect(doc.changed).toBe(true);
    expect(doc.clip).toMatchObject({
      startUs: 2 * SEC,
      durationUs: 10 * SEC,
      sourceInUs: 2 * SEC,
    });
    const persisted = await showProject(sb, id);
    expect(spans(persisted)).toEqual([[2, 12]]);
    expect(persisted.tracks[0]!.clips[0]!.sourceInUs).toBe(2 * SEC);
  });

  it('can move a composition clip earlier without moving its child in-point below zero', async () => {
    const id = await createProject(sb, 'Nested composition');
    const file = sb.path('composition.json');
    expectOk(await sb.run(['project', 'export', id, '--output', file, '--json']));

    type Composition = {
      id: string;
      name: string;
      tracks: Array<{ id: string; clips: Array<Record<string, unknown>>; [key: string]: unknown }>;
      [key: string]: unknown;
    };
    type ExportedProject = {
      source: {
        rootCompositionId: string;
        compositions: Record<string, Composition>;
      };
      [key: string]: unknown;
    };
    type SavedProject = {
      project: {
        rootCompositionId: string;
        compositions: Record<string, Composition>;
      };
    };

    const exported = JSON.parse(readFileSync(file, 'utf8')) as ExportedProject;
    const { source } = exported;
    const root = source.compositions[source.rootCompositionId]!;
    source.compositions.child = {
      ...structuredClone(root),
      id: 'child',
      name: 'Child composition',
      tracks: root.tracks.map((t) => ({ ...t, clips: [] })),
    };
    root.tracks[0]!.clips.push({
      id: 'nested-clip',
      kind: 'composition',
      compositionId: 'child',
      startUs: SEC,
      durationUs: 5 * SEC,
      childOffsetUs: 0,
    });
    writeFileSync(file, JSON.stringify(exported), 'utf8');
    const before = readFileSync(file);

    const result = expectOk(
      await sb.run([
        'timeline',
        'trim',
        '--project',
        file,
        '--clip',
        'nested-clip',
        '--start',
        '0',
        '--end',
        '5',
        '--json',
      ]),
    );
    expect(
      singleJson<{ clip: { startUs: number; durationUs: number } }>(result).clip,
    ).toMatchObject({
      startUs: 0,
      durationUs: 5 * SEC,
    });
    expect(readFileSync(file)).not.toEqual(before);
    const saved = JSON.parse(readFileSync(file, 'utf8')) as SavedProject;
    const rootAfter = saved.project.compositions[saved.project.rootCompositionId]!;
    expect(rootAfter.tracks[0]!.clips[0]).toMatchObject({
      id: 'nested-clip',
      startUs: 0,
      childOffsetUs: 0,
    });
  });

  it('applying the same trim twice is idempotent: the second says nothing changed and does not bump the revision', async () => {
    const { id, clip } = await introProject();
    const args = ['timeline', 'trim', '--project', id, '--clip', clip, '--end', '20', '--json'];
    const first = singleJson<{ changed: boolean; revision: number }>(expectOk(await sb.run(args)));
    expect(first).toMatchObject({ changed: true, revision: 3 });

    const again = expectOk(await sb.run(args));
    expect(singleJson<{ changed: boolean; revision: number }>(again)).toMatchObject({
      changed: false,
      revision: 3,
    });
    expect((await showProject(sb, id)).revision).toBe(3);

    const human = expectOk(await sb.run(args.slice(0, -1)));
    expect(human.out).toMatch(/already spans 0s to 20s; nothing to change/);
  });

  it('a trim with nothing to trim is a usage error, not a silent revision bump', async () => {
    const { id, clip } = await introProject();
    const r = expectExit(await sb.run(['timeline', 'trim', '--project', id, '--clip', clip]), 2);
    expect(r.err).toMatch(/Nothing to trim/);
    expect((await showProject(sb, id)).revision).toBe(2);
  });

  it('a trim --end that lands before the clip even starts is rejected, not turned into a 1 ms sliver', async () => {
    const id = await createProject(sb, 'Sliver');
    await addClip(sb, id, { duration: 4 });
    const late = await addClip(sb, id, { start: 10, duration: 5 });
    const before = await fingerprint(sb, id);

    const r = expectExit(
      await sb.run(['timeline', 'trim', '--project', id, '--clip', late.id, '--end', '3']),
      1,
    );
    expect(r.err).toMatch(/--end \(3s\) must be after the clip start \(10s\)/);
    expect(await fingerprint(sb, id)).toBe(before);
  });

  it.each([
    [
      '--end together with --duration',
      ['--end', '5', '--duration', '2'],
      /either --end or --duration/,
    ],
    [
      '--end not after --start',
      ['--start', '8', '--end', '8'],
      /--end \(8s\) must be greater than --start \(8s\)/,
    ],
    ['--end before --start', ['--start', '8', '--end', '3'], /must be greater than --start/],
  ])('a contradictory trim (%s) is a usage error', async (_label, flags, message) => {
    const { id, clip } = await introProject();
    const before = await fingerprint(sb, id);
    const r = expectExit(
      await sb.run(['timeline', 'trim', '--project', id, '--clip', clip, ...flags]),
      2,
    );
    expect(r.err).toMatch(message);
    expect(await fingerprint(sb, id)).toBe(before);
  });

  it('a trim that would run into the next clip on the same track is refused', async () => {
    const id = await createProject(sb, 'Neighbours');
    const a = await addClip(sb, id, { duration: 5 });
    await addClip(sb, id, { start: 8, duration: 5 });
    const before = await fingerprint(sb, id);

    const r = expectExit(
      await sb.run(['timeline', 'trim', '--project', id, '--clip', a.id, '--end', '9']),
      1,
    );
    expect(r.err).toMatch(/overlaps clip/);
    expect(await fingerprint(sb, id)).toBe(before);

    // Up to the neighbour's edge is fine.
    expectOk(await sb.run(['timeline', 'trim', '--project', id, '--clip', a.id, '--end', '8']));
    expect(spans(await showProject(sb, id))).toEqual([
      [0, 8],
      [8, 13],
    ]);
  });
});

describe('placing and removing clips', () => {
  it('an agent that repeats the same add-clip gets a clear overlap error instead of two stacked clips', async () => {
    const id = await createProject(sb, 'Twice');
    const args = ['timeline', 'add-clip', '--project', id, '--duration', '5'];
    expectOk(await sb.run(args));
    const again = expectExit(await sb.run(args), 1);
    expect(again.err).toMatch(/overlaps clip/);
    expect(again.err, 'tells the caller how to fix it').toMatch(/--start .*5s|another --track/);
    const show = await showProject(sb, id);
    expect(spans(show)).toEqual([[0, 5]]);
    expect(show.revision, 'the failed call did not write').toBe(2);
  });

  it('allows clips back to back on a track, and stacked on different tracks', async () => {
    const id = await createProject(sb, 'Layers');
    await addClip(sb, id, { duration: 5 });
    await addClip(sb, id, { start: 5, duration: 5 });
    await addClip(sb, id, { track: 'track-v2', duration: 8 });
    const show = await showProject(sb, id);
    expect(spans(show, 'track-v1')).toEqual([
      [0, 5],
      [5, 10],
    ]);
    expect(spans(show, 'track-v2')).toEqual([[0, 8]]);
  });

  it('records the asset it was given, and the default clip length is 3 s', async () => {
    const id = await createProject(sb, 'Defaults');
    const c = singleJson<{ clip: { assetId: string; durationUs: number } }>(
      expectOk(
        await sb.run(['timeline', 'add-clip', '--project', id, '--asset', 'beach.mp4', '--json']),
      ),
    );
    expect(c.clip).toMatchObject({ assetId: 'beach.mp4', durationUs: 3 * SEC });
  });

  it('removing a clip twice: the first works, the second is "not found", and neighbours survive', async () => {
    const id = await createProject(sb, 'Remove');
    const a = await addClip(sb, id, { duration: 4 });
    const b = await addClip(sb, id, { start: 4, duration: 4 });

    const first = expectOk(
      await sb.run(['timeline', 'remove-clip', '--project', id, '--clip', a.id]),
    );
    expect(first.out).toMatch(/Removed clip .* \(saved rev 4\)\./);

    const second = expectExit(
      await sb.run(['timeline', 'remove-clip', '--project', id, '--clip', a.id]),
      1,
    );
    expect(second.err).toContain(`Clip "${a.id}" not found`);
    expect(second.err, 'lists what does exist').toContain(b.id);

    const show = await showProject(sb, id);
    expect(show.revision).toBe(4);
    expect(track(show, 'track-v1').clips.map((c) => c.id)).toEqual([b.id]);
  });

  it('a typo in the clip id says which clips exist', async () => {
    const { id, clip } = await introProject();
    const r = expectExit(
      await sb.run(['timeline', 'remove-clip', '--project', id, '--clip', `${clip}x`]),
      1,
    );
    expect(r.err).toContain(`Clip "${clip}x" not found`);
    expect(r.err).toContain(clip);
  });

  it('an empty project says it has no clips yet', async () => {
    const id = await createProject(sb, 'Empty');
    const r = expectExit(
      await sb.run(['timeline', 'split', '--project', id, '--clip', 'c1', '--at', '1']),
      1,
    );
    expect(r.err).toMatch(/not found\. This project has no clips yet/);
  });
});

describe('tracks', () => {
  it('adding to a track that does not exist lists the real ones', async () => {
    const id = await createProject(sb, 'Tracks');
    const r = expectExit(
      await sb.run(['timeline', 'add-clip', '--project', id, '--track', 'track-nope']),
      1,
    );
    expect(r.err).toContain('Track "track-nope" not found');
    expect(r.err).toContain('track-v1, track-v2, track-a1');
    expect(spans(await showProject(sb, id))).toEqual([]);
  });

  it('--track is honoured, not ignored, by split / trim / remove-clip', async () => {
    const id = await createProject(sb, 'Scoped');
    const onV1 = await addClip(sb, id, { track: 'track-v1', duration: 10 });
    const before = await fingerprint(sb, id);

    for (const op of [['split', '--at', '5'], ['trim', '--end', '5'], ['remove-clip']]) {
      const ghost = expectExit(
        await sb.run([
          'timeline',
          op[0]!,
          '--project',
          id,
          '--clip',
          onV1.id,
          '--track',
          'nope',
          ...op.slice(1),
        ]),
        1,
      );
      expect(ghost.err, describeRun(ghost)).toContain('Track "nope" not found');

      const wrong = expectExit(
        await sb.run([
          'timeline',
          op[0]!,
          '--project',
          id,
          '--clip',
          onV1.id,
          '--track',
          'track-v2',
          ...op.slice(1),
        ]),
        1,
      );
      expect(wrong.err, describeRun(wrong)).toContain(
        `Clip "${onV1.id}" is not on track "track-v2" (it is on track "track-v1")`,
      );
    }
    expect(await fingerprint(sb, id), 'nothing was changed by the refused calls').toBe(before);

    // The right track works.
    expectOk(
      await sb.run([
        'timeline',
        'split',
        '--project',
        id,
        '--clip',
        onV1.id,
        '--track',
        'track-v1',
        '--at',
        '5',
      ]),
    );
    expect(spans(await showProject(sb, id))).toEqual([
      [0, 5],
      [5, 10],
    ]);
  });
});

describe('the command line itself is wrong (exit 2, nothing written)', () => {
  const cases: Array<[string, (id: string, clip: string) => string[], RegExp]> = [
    ['no subcommand', (id) => ['timeline', '--project', id], /Missing timeline subcommand/],
    [
      'unknown subcommand',
      (id) => ['timeline', 'cut', '--project', id],
      /Unknown timeline subcommand: cut\. Available: add-clip, split, trim, remove-clip/,
    ],
    [
      'a stray positional',
      (id) => ['timeline', 'add-clip', 'intro.mp4', '--project', id],
      /Unexpected extra argument "intro\.mp4"/,
    ],
    ['no --project', () => ['timeline', 'add-clip'], /Please specify target project via --project/],
    [
      'split without --at',
      (id, clip) => ['timeline', 'split', '--project', id, '--clip', clip],
      /Usage: joy-media timeline split/,
    ],
    [
      'split without --clip',
      (id) => ['timeline', 'split', '--project', id, '--at', '3'],
      /Usage: joy-media timeline split/,
    ],
    [
      'trim without --clip',
      (id) => ['timeline', 'trim', '--project', id, '--end', '3'],
      /Usage: joy-media timeline trim/,
    ],
    [
      'remove-clip without --clip',
      (id) => ['timeline', 'remove-clip', '--project', id],
      /Usage: joy-media timeline remove-clip/,
    ],
    [
      'add-clip given --at (meant --start)',
      (id) => ['timeline', 'add-clip', '--project', id, '--at', '5'],
      /add-clip does not accept --at\. It takes: --track, --start, --duration, --asset/,
    ],
    [
      'add-clip given --end',
      (id) => ['timeline', 'add-clip', '--project', id, '--end', '5'],
      /add-clip does not accept --end/,
    ],
    [
      'split given --duration (meant --at)',
      (id, clip) => [
        'timeline',
        'split',
        '--project',
        id,
        '--clip',
        clip,
        '--at',
        '2',
        '--duration',
        '3',
      ],
      /split does not accept --duration/,
    ],
    [
      'remove-clip given --start',
      (id, clip) => ['timeline', 'remove-clip', '--project', id, '--clip', clip, '--start', '2'],
      /remove-clip does not accept --start/,
    ],
  ];

  it.each(cases)('%s', async (_label, build, message) => {
    const { id, clip } = await introProject();
    const before = await fingerprint(sb, id);
    const r = expectExit(await sb.run(build(id, clip)), 2);
    expect(r.err, describeRun(r)).toMatch(message);
    expect(r.out.trim(), 'diagnostics belong on stderr').toBe('');
    expect(await fingerprint(sb, id)).toBe(before);
  });

  it.each([
    ['--duration', 'abc'],
    ['--duration', '-1'],
    ['--duration', '0'],
    ['--duration', '86401'],
    ['--duration', '5s'],
    ['--duration', '۵'],
    ['--duration', 'NaN'],
    ['--duration', 'Infinity'],
    ['--start', '-3'],
    ['--start', '86401'],
  ])('add-clip %s %s is rejected', async (flag, value) => {
    const id = await createProject(sb, 'Numbers');
    const r = expectExit(await sb.run(['timeline', 'add-clip', '--project', id, flag, value]), 2);
    expect(r.err, describeRun(r)).toContain(flag);
    expect(spans(await showProject(sb, id))).toEqual([]);
  });

  it.each([
    ['--at', 'abc'],
    ['--at', '-1'],
    ['--at', '1,5'],
    ['--end', '12abc'],
  ])('split / trim %s %s is rejected', async (flag, value) => {
    const { id, clip } = await introProject();
    const before = await fingerprint(sb, id);
    const op = flag === '--at' ? 'split' : 'trim';
    const r = expectExit(
      await sb.run(['timeline', op, '--project', id, '--clip', clip, flag, value]),
      2,
    );
    expect(r.err, describeRun(r)).toContain(flag);
    expect(await fingerprint(sb, id)).toBe(before);
  });

  it('numbers are accepted in the common spellings (2.5, 1e1, .5)', async () => {
    const id = await createProject(sb, 'Spellings');
    const doc = async (
      args: string[],
    ): Promise<{ clip: { startUs: number; durationUs: number } }> =>
      singleJson(
        expectOk(await sb.run(['timeline', 'add-clip', '--project', id, ...args, '--json'])),
      );
    expect((await doc(['--start', '1', '--duration', '2.5'])).clip.durationUs).toBe(2.5 * SEC);
    expect((await doc(['--start', '10', '--duration', '1e1'])).clip.durationUs).toBe(10 * SEC);
    expect(await doc(['--track', 'track-v2', '--start', '.5', '--duration', '.25'])).toMatchObject({
      clip: { startUs: 500_000, durationUs: 250_000 },
    });
  });

  it('accepts the largest allowed start and duration', async () => {
    const id = await createProject(sb, 'Limits');
    const far = await addClip(sb, id, { start: 86_400, duration: 86_400 });
    expect(far).toMatchObject({ startUs: 86_400 * SEC, durationUs: 86_400 * SEC });
  });
});

describe('every failing edit leaves the project exactly as it was', () => {
  it('survives a barrage of mistakes with nothing written', async () => {
    const id = await createProject(sb, 'Barrage');
    const a = await addClip(sb, id, { duration: 10 });
    const b = await addClip(sb, id, { start: 12, duration: 5 });
    const before = await fingerprint(sb, id);

    const base = ['timeline'];
    const mistakes: string[][] = [
      [...base, 'split', '--project', id, '--clip', a.id, '--at', '10'],
      [...base, 'split', '--project', id, '--clip', a.id, '--at', '99'],
      [...base, 'split', '--project', id, '--clip', 'nope', '--at', '1'],
      [...base, 'split', '--project', id, '--clip', b.id, '--at', '1'],
      [...base, 'trim', '--project', id, '--clip', a.id, '--end', '13'],
      [...base, 'trim', '--project', id, '--clip', b.id, '--end', '3'],
      [...base, 'trim', '--project', id, '--clip', a.id],
      [...base, 'trim', '--project', id, '--clip', 'nope', '--end', '2'],
      [...base, 'remove-clip', '--project', id, '--clip', 'nope'],
      [...base, 'add-clip', '--project', id, '--start', '1', '--duration', '2'],
      [...base, 'add-clip', '--project', id, '--track', 'nope'],
      [...base, 'add-clip', '--project', id, '--duration', 'abc'],
      [...base, 'add-clip', '--project', 'proj-nope'],
      [...base, 'bogus', '--project', id],
    ];
    for (const args of mistakes) {
      const r = await sb.run(args);
      expect([1, 2], describeRun(r)).toContain(r.code);
      expect(await fingerprint(sb, id), `after: ${args.join(' ')}`).toBe(before);
    }
  });

  it('an unknown project is "not found" (exit 1) and does not create a database', async () => {
    const r = expectExit(await sb.run(['timeline', 'add-clip', '--project', 'proj-typo']), 1);
    expect(r.err).toMatch(/Project "proj-typo" not found/);
    expect(r.out.trim()).toBe('');
    expect(existsSync(defaultProjectDbPath(sb))).toBe(false);
    expect(readdirSync(sb.joyDir).filter((n) => n.endsWith('.lock'))).toEqual([]);
  });
});

describe('an AI agent scripts timeline edits with --json', () => {
  it('gets one JSON document per call, with a revision it can chain on', async () => {
    const id = await createProject(sb, 'Scripted');

    const add = singleJson<{
      projectId: string;
      revision: number;
      changed: boolean;
      trackId: string;
      clip: { id: string; startUs: number; durationUs: number; endUs: number };
    }>(
      expectOk(
        await sb.run(['timeline', 'add-clip', '--project', id, '--duration', '20', '--json']),
      ),
    );
    expect(add).toMatchObject({ projectId: id, revision: 2, changed: true, trackId: 'track-v1' });
    expect(add.clip).toMatchObject({ startUs: 0, durationUs: 20 * SEC, endUs: 20 * SEC });

    const cut = await split(id, add.clip.id, 8);
    expect(cut).toMatchObject({ projectId: id, revision: 3, changed: true, trackId: 'track-v1' });
    expect(cut.clips.map((c) => c.durationUs)).toEqual([8 * SEC, 12 * SEC]);

    const trim = singleJson<{ revision: number; clip: { endUs: number } }>(
      expectOk(
        await sb.run([
          'timeline',
          'trim',
          '--project',
          id,
          '--clip',
          cut.clips[1]!.id,
          '--end',
          '15',
          '--json',
        ]),
      ),
    );
    expect(trim).toMatchObject({ revision: 4, clip: { endUs: 15 * SEC } });

    const removed = singleJson<{ revision: number; removed: { id: string } }>(
      expectOk(
        await sb.run(['timeline', 'remove-clip', '--project', id, '--clip', add.clip.id, '--json']),
      ),
    );
    expect(removed).toMatchObject({ revision: 5, removed: { id: add.clip.id } });

    // What the last response promised is what a fresh process finds.
    const show = await showProject(sb, id);
    expect(show.revision).toBe(removed.revision);
    expect(spans(show)).toEqual([[8, 15]]);
  });

  it('gets a machine-readable error document (and a non-zero exit) for each kind of failure', async () => {
    const { id, clip } = await introProject();
    const cases: Array<[string[], number, string]> = [
      [['timeline', 'split', '--project', id, '--clip', clip, '--at', '99'], 1, 'RANGE_ERROR'],
      [['timeline', 'split', '--project', id, '--clip', 'nope', '--at', '1'], 1, 'CLIP_NOT_FOUND'],
      [['timeline', 'add-clip', '--project', id, '--track', 'nope'], 1, 'TRACK_NOT_FOUND'],
      [['timeline', 'add-clip', '--project', id], 1, 'CLIP_OVERLAP'],
      [['timeline', 'add-clip', '--project', 'proj-nope'], 1, 'PROJECT_NOT_FOUND'],
      [['timeline', 'trim', '--project', id, '--clip', clip], 2, 'USAGE'],
      [['timeline', 'frob', '--project', id], 2, 'USAGE'],
    ];
    for (const [args, exit, code] of cases) {
      const r = await sb.run([...args, '--json']);
      const doc = jsonError(r, exit);
      expect(doc.code, describeRun(r)).toBe(code);
      expect(r.err, 'the human message is also on stderr').toContain(doc.message.slice(0, 20));
    }
  });

  it('success output has no colour codes, JSON or not', async () => {
    const { id, clip } = await introProject();
    for (const args of [
      ['timeline', 'trim', '--project', id, '--clip', clip, '--end', '20'],
      ['timeline', 'trim', '--project', id, '--clip', clip, '--end', '10', '--json'],
    ]) {
      const r = expectOk(await sb.run(args));
      expect(hasAnsi(r.stdout)).toBe(false);
      expect(hasAnsi(r.stderr)).toBe(false);
    }
  });
});

describe('flag spelling and order do not matter', () => {
  it('works with -p, --project=<id>, and flags placed before the subcommand', async () => {
    const { id, clip } = await introProject();
    expectOk(await sb.run(['timeline', 'split', '-p', id, '--clip', clip, '--at', '4']));
    expectOk(await sb.run(['timeline', 'split', `--project=${id}`, `--clip=${clip}`, '--at=2']));
    expectOk(
      await sb.run([
        '--project',
        id,
        '--json',
        'timeline',
        'add-clip',
        '--start',
        '40',
        '--duration',
        '2',
      ]),
    );
    expect(spans(await showProject(sb, id))).toEqual([
      [0, 2],
      [2, 4],
      [4, 30],
      [40, 42],
    ]);
  });
});

describe('a long editing session', () => {
  it('persists all 200 successful edits with a fresh-process readback', async () => {
    const id = await createProject(sb, 'Two hundred edits');
    const startedAt = performance.now();
    for (let i = 0; i < 200; i += 1) {
      await addClip(sb, id, { start: i * 2, duration: 1 });
    }
    const elapsedMs = performance.now() - startedAt;

    // `showProject` and `listProjects` each start a new CLI process, so the
    // counts below prove the durable store, not only the last command result.
    const show = await showProject(sb, id);
    expect(show.revision).toBe(201);
    expect(track(show, 'track-v1').clips).toHaveLength(200);
    expect(spans(show)).toEqual(Array.from({ length: 200 }, (_, i) => [i * 2, i * 2 + 1]));
    expect((await listProjects(sb))[0]).toMatchObject({ revision: 201, clipCount: 200 });
    expect(elapsedMs).toBeGreaterThan(0);
  }, 240_000);

  it('counts one revision per successful edit, stays readable, and keeps bounded history', async () => {
    const id = await createProject(sb, 'Session');
    for (let i = 0; i < 12; i += 1) {
      await addClip(sb, id, { start: 1 + i * 3, duration: 2 });
    }
    const show = await showProject(sb, id);
    expect(show.revision).toBe(13);
    expect(track(show, 'track-v1').clips).toHaveLength(12);
    expect((await listProjects(sb))[0]).toMatchObject({ revision: 13, clipCount: 12 });

    // The store keeps a bounded number of snapshots (older revisions are pruned).
    const db = new DatabaseSync(defaultProjectDbPath(sb), { readOnly: true });
    try {
      const row = db
        .prepare('SELECT COUNT(*) AS n FROM snapshots WHERE project_id = ?')
        .get(id) as {
        n: number;
      };
      expect(row.n).toBeLessThanOrEqual(10);
    } finally {
      db.close();
    }
  });

  it('never prompts: a destructive edit completes even when stdin says "no"', async () => {
    const { id, clip } = await introProject();
    const r = expectOk(
      await sb.run(['timeline', 'remove-clip', '--project', id, '--clip', clip], {
        input: 'n\nn\n',
        timeoutMs: 20_000,
      }),
    );
    expect(r.timedOut).toBe(false);
    expect(track(await showProject(sb, id), 'track-v1').clips).toEqual([]);
  });
});

describe('editing a project file instead of the database', () => {
  it('add, split, trim and remove work on an exported file; the file stays a valid project', async () => {
    const id = await createProject(sb, 'On disk');
    expectOk(await sb.run(['project', 'export', id, '--output', 'edit.json']));

    const c = await addClip(sb, 'edit.json', { duration: 10 });
    const cut = await split('edit.json', c.id, 4);
    expect(cut.revision).toBe(3);
    expectOk(
      await sb.run([
        'timeline',
        'trim',
        '--project',
        'edit.json',
        '--clip',
        cut.clips[1]!.id,
        '--end',
        '8',
      ]),
    );
    expectOk(
      await sb.run([
        'timeline',
        'remove-clip',
        '--project',
        'edit.json',
        '--clip',
        cut.clips[0]!.id,
      ]),
    );

    const show = await showProject(sb, 'edit.json');
    expect(show).toMatchObject({ source: 'file', revision: 5 });
    expect(spans(show)).toEqual([[4, 8]]);
    expect(readdirSync(sb.cwd).sort(), 'no temp files left behind').toEqual(['edit.json']);

    // The file is still importable and valid after all the edits.
    expectOk(await sb.run(['project', 'import', 'edit.json']));
    const reexported = await exportAndValidate(sb, id, 'again.json');
    expect(reexported.revision).toBeGreaterThanOrEqual(5);
  });

  it('a refused edit leaves the file byte-for-byte unchanged', async () => {
    const id = await createProject(sb, 'Untouched');
    expectOk(await sb.run(['project', 'export', id, '--output', 'keep.json']));
    await addClip(sb, 'keep.json', { duration: 5 });
    const bytes = readFileSync(sb.path('keep.json'), 'utf8');

    expectExit(
      await sb.run(['timeline', 'split', '--project', 'keep.json', '--clip', 'nope', '--at', '1']),
      1,
    );
    expectExit(
      await sb.run(['timeline', 'add-clip', '--project', 'keep.json', '--duration', '2']),
      1,
    );
    expect(readFileSync(sb.path('keep.json'), 'utf8')).toBe(bytes);
  });

  it('a project file that is not valid JSON is reported by name and never rewritten', async () => {
    writeFileSync(sb.path('broken.json'), '{ not json');
    const r = expectExit(await sb.run(['timeline', 'add-clip', '--project', 'broken.json']), 1);
    expect(r.err).toMatch(/broken\.json is not valid JSON/);
    expect(readFileSync(sb.path('broken.json'), 'utf8')).toBe('{ not json');
    expect(readdirSync(sb.cwd).sort()).toEqual(['broken.json']);
  });
});
