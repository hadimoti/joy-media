/**
 * `joy-media project ...` the way a creator or an AI agent really uses it.
 * Every test drives the real binary in a throw-away HOME and reads the result
 * back with a second, fresh process.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildHistoricalSchemaProjects } from '@joy-media/test-fixtures';
import { createSandbox, describeRun, hasAnsi, type Sandbox } from './harness.js';
import {
  addClip,
  persistenceFaultEnv,
  createProject,
  defaultProjectDbPath,
  exportAndValidate,
  expectExit,
  expectOk,
  jsonError,
  listProjects,
  showProject,
  singleJson,
} from './project-helpers.js';

vi.setConfig({ testTimeout: 60_000 });

let sb: Sandbox;
beforeEach(() => {
  sb = createSandbox('project');
});
afterEach(() => sb.cleanup());

const dbFile = (): string => defaultProjectDbPath(sb);

describe('a creator starts a project', () => {
  it('names it with the positional argument, the way `project list` suggests', async () => {
    const r = expectOk(await sb.run(['project', 'create', 'My Project']));
    expect(r.out).toMatch(/Created project: My Project \(proj-[\w-]+\) at revision 1\./);
    expect(hasAnsi(r.stdout), 'ANSI on a piped stdout').toBe(false);

    const [only, ...rest] = await listProjects(sb);
    expect(rest).toEqual([]);
    expect(only?.title).toBe('My Project');
  });

  it('an AI agent names it with --name and sets the canvas: the name is not ignored', async () => {
    const r = expectOk(
      await sb.run([
        'project',
        'create',
        '--name',
        'Demo reel',
        '--width',
        '1920',
        '--height',
        '1080',
        '--fps',
        '30',
        '--json',
      ]),
    );
    const created = singleJson<{
      id: string;
      title: string;
      revision: number;
      width: number;
      height: number;
      fps: number;
    }>(r);
    expect(created).toMatchObject({
      title: 'Demo reel',
      revision: 1,
      width: 1920,
      height: 1080,
      fps: 30,
    });

    // Read back with a fresh process.
    const show = await showProject(sb, created.id);
    expect(show).toMatchObject({
      title: 'Demo reel',
      width: 1920,
      height: 1080,
      frameRate: 30,
      revision: 1,
    });
  });

  it('prints the chosen name (not "Untitled Project") in the human confirmation too', async () => {
    const r = expectOk(await sb.run(['project', 'create', '--name', 'Demo reel']));
    expect(r.out).toContain('Created project: Demo reel');
    expect(r.out).not.toContain('Untitled');
  });

  it.each([
    ['--name=Eq', ['--name=Equals form']],
    ['-n', ['-n', 'Short form']],
    ['--name before the flags', ['--name', 'Flag first', '--width', '1280', '--height', '720']],
  ])('accepts the name as %s', async (_label, args) => {
    const r = expectOk(await sb.run(['project', 'create', ...args, '--json']));
    const { id, title } = singleJson<{ id: string; title: string }>(r);
    expect(title).not.toMatch(/Untitled/);
    expect((await showProject(sb, id)).title).toBe(title);
    expect(['Equals form', 'Short form', 'Flag first']).toContain(title);
  });

  it('joins an unquoted multi-word name, like most shells users type it', async () => {
    const r = expectOk(await sb.run(['project', 'create', 'My', 'Great', 'Reel', '--json']));
    expect(singleJson<{ title: string }>(r).title).toBe('My Great Reel');
  });

  it('with no name at all, makes an "Untitled Project" (documented default)', async () => {
    const r = expectOk(await sb.run(['project', 'create', '--json']));
    expect(singleJson<{ title: string }>(r).title).toBe('Untitled Project');
  });

  it('accepts the same name given twice (positional and --name)', async () => {
    const r = expectOk(await sb.run(['project', 'create', 'Same', '--name', 'Same', '--json']));
    expect(singleJson<{ title: string }>(r).title).toBe('Same');
  });

  it('refuses two different names instead of silently picking one, and creates nothing', async () => {
    const r = expectExit(await sb.run(['project', 'create', 'First', '--name', 'Second']), 2);
    expect(r.err).toMatch(/two different project names/i);
    expect(r.out.trim()).toBe('');
    expect(await listProjects(sb)).toEqual([]);
    expect(existsSync(dbFile()), 'a rejected command must not create the database').toBe(false);
  });

  it('refuses an explicitly empty name as a usage error', async () => {
    for (const args of [
      ['project', 'create', ''],
      ['project', 'create', '--name', ''],
    ]) {
      const r = expectExit(await sb.run(args), 2);
      expect(r.err, describeRun(r)).toMatch(/name is empty/i);
    }
    expect(await listProjects(sb)).toEqual([]);
  });

  // Bug in apps/cli/src/cli.ts (not owned by this suite): parseArgs runs with
  // `strict: false`, so `--name` with no value becomes boolean `true` and the
  // handler cannot tell it from "no name given". Expected: exit 2 and nothing created.
  it('rejects `--name` with no value instead of silently creating an untitled project', async () => {
    const r = await sb.run(['project', 'create', '--name']);
    expect(r.code, describeRun(r)).toBe(2);
  });

  // Same root cause: unknown flags are swallowed, so a typo like `--nmae` silently
  // produces "Untitled Project" - the typical AI mistake the CLI should catch.
  it("rejects a typo'd flag (--nmae) instead of silently ignoring it", async () => {
    const r = await sb.run(['project', 'create', '--nmae', 'Demo reel']);
    expect(r.code, describeRun(r)).toBe(2);
  });

  it.each([
    'پروژه من 🎬',
    'Café "quoted" it\'s',
    '日本語 プロジェクト',
    "O'Brien & Sons <intro>",
    'back\\slash and $HOME `date` $(whoami)',
    'two\nlines',
  ])('keeps the name %j intact from create to show to list', async (name) => {
    const id = await createProject(sb, name);
    expect((await showProject(sb, id)).title).toBe(name);
    expect((await listProjects(sb)).find((p) => p.id === id)?.title).toBe(name);
  });

  it('keeps a 5000-character name', async () => {
    const name = 'x'.repeat(5000);
    const id = await createProject(sb, name);
    expect((await showProject(sb, id)).title).toBe(name);
  });

  it('can name a project that starts with a dash, via --name=<value> or `--`', async () => {
    const a = singleJson<{ title: string }>(
      expectOk(await sb.run(['project', 'create', '--name=-Dash intro', '--json'])),
    );
    expect(a.title).toBe('-Dash intro');
    const b = singleJson<{ title: string }>(
      expectOk(await sb.run(['project', 'create', '--json', '--', '-Second dash'])),
    );
    expect(b.title).toBe('-Second dash');
  });

  it('calling create twice makes two distinct projects (create is not idempotent by name)', async () => {
    const a = await createProject(sb, 'Twice');
    const b = await createProject(sb, 'Twice');
    expect(a).not.toBe(b);
    const projects = await listProjects(sb);
    expect(projects.map((p) => p.id).sort()).toEqual([a, b].sort());
  });

  it('the canvas accepts numbers as strings and exact limits, and rejects the rest with exit 2', async () => {
    const small = singleJson<{ width: number; height: number; fps: number }>(
      expectOk(
        await sb.run([
          'project',
          'create',
          'Tiny',
          '--width',
          '16',
          '--height',
          '16',
          '--fps',
          '1',
          '--json',
        ]),
      ),
    );
    expect(small).toMatchObject({ width: 16, height: 16, fps: 1 });
    expectOk(
      await sb.run([
        'project',
        'create',
        'Huge',
        '--width=15360',
        '--height=8640',
        '--fps=240',
        '--json',
      ]),
    );

    const before = (await listProjects(sb)).length;
    for (const [flag, value] of [
      ['--width', '1920px'],
      ['--width', 'abc'],
      ['--width', '1080.5'],
      ['--width', '-1'],
      ['--width', '0'],
      ['--width', '15'],
      ['--width', '15361'],
      ['--height', '8641'],
      ['--fps', '0'],
      ['--fps', '241'],
      ['--fps', 'thirty'],
    ]) {
      const r = expectExit(await sb.run(['project', 'create', 'Bad', flag!, value!]), 2);
      expect(r.err, describeRun(r)).toContain(flag!);
      expect(r.out.trim(), 'nothing is printed on stdout for a rejected command').toBe('');
    }
    expect((await listProjects(sb)).length, 'no project was created by a rejected command').toBe(
      before,
    );
  });
});

describe('an AI agent lists projects', () => {
  it('gets `[]` (not a banner) when nothing exists yet, and no database is created', async () => {
    const r = expectOk(await sb.run(['project', 'list', '--json']));
    expect(singleJson<unknown[]>(r)).toEqual([]);
    expect(r.out).not.toMatch(/JOY MEDIA|No projects/);
    expect(existsSync(dbFile()), 'reading must not create the database').toBe(false);
  });

  it('gets ONE clean JSON document with the fields it needs, and can chain the id into other commands', async () => {
    const a = await createProject(sb, 'Alpha');
    const b = await createProject(sb, 'Beta', ['--width', '1920', '--height', '1080']);
    await addClip(sb, b, { duration: 4 });
    await addClip(sb, b, { start: 5, duration: 4 });

    const r = expectOk(await sb.run(['project', 'list', '--json']));
    const list = singleJson<
      Array<{
        id: string;
        title: string;
        revision: number;
        clipCount: number;
        trackCount: number;
        durationSeconds: number;
        updatedAt: string;
      }>
    >(r);
    expect(r.out).not.toMatch(/JOY MEDIA|Local Projects|─/);

    const byId = new Map(list.map((p) => [p.id, p]));
    expect(byId.get(a)).toMatchObject({ title: 'Alpha', revision: 1, clipCount: 0, trackCount: 3 });
    expect(byId.get(b)).toMatchObject({ title: 'Beta', revision: 3, clipCount: 2, trackCount: 3 });
    expect(new Date(byId.get(b)!.updatedAt).toString()).not.toBe('Invalid Date');

    // The id from the listing is directly usable.
    expect((await showProject(sb, list[0]!.id)).id).toBe(list[0]!.id);
  });

  it('gets the same document on every call (stable, side-effect free)', async () => {
    await createProject(sb, 'One');
    await createProject(sb, 'Two');
    const first = expectOk(await sb.run(['project', 'list', '--json'])).stdout;
    const second = expectOk(await sb.run(['project', 'list', '--json'])).stdout;
    expect(second).toBe(first);
  });

  it('can put --json before the command (flag order is not significant)', async () => {
    await createProject(sb, 'Order');
    const r = expectOk(await sb.run(['--json', 'project', 'list']));
    expect(singleJson<unknown[]>(r)).toHaveLength(1);
  });

  it('a bare `project` lists, and a human gets a readable table without colour codes', async () => {
    const id = await createProject(sb, 'Readable table');
    for (const args of [['project'], ['project', 'list']]) {
      const r = expectOk(await sb.run(args));
      expect(r.out).toContain('Readable table');
      expect(r.out).toContain(id);
      expect(hasAnsi(r.stdout), 'ANSI on a piped stdout').toBe(false);
    }
  });

  it('a human with no projects gets guidance, exit 0, and the hint shows the right database', async () => {
    const custom = sb.path('elsewhere.sqlite3');
    const r = expectOk(await sb.run(['project', 'list', '--sqlite-path', custom]));
    expect(r.out).toMatch(/No projects found/);
    expect(r.out).toContain(custom);
    expect(r.out).toContain('project create');
  });
});

describe('showing one project', () => {
  it('a human sees title, revision, canvas, tracks and clips', async () => {
    const id = await createProject(sb, 'Show me', ['--width', '1920', '--height', '1080']);
    await addClip(sb, id, { start: 1, duration: 4 });
    const r = expectOk(await sb.run(['project', 'show', id]));
    expect(r.out).toContain('Show me');
    expect(r.out).toContain(id);
    expect(r.out).toContain('Revision: 2');
    expect(r.out).toContain('1920×1080');
    expect(r.out).toMatch(/Video 1 \[visual\].*1 clip/);
    expect(r.out).toMatch(/1\.00s -> 5\.00s \(4\.00s\)/);
    expect(hasAnsi(r.stdout)).toBe(false);
  });

  it('an AI agent gets one JSON document describing the whole timeline', async () => {
    const id = await createProject(sb, 'Machine view', ['--width', '1920', '--height', '1080']);
    const clip = await addClip(sb, id, { track: 'track-v2', start: 2, duration: 6, asset: 'a-1' });

    const r = expectOk(await sb.run(['project', 'show', id, '--json']));
    const show = singleJson<Awaited<ReturnType<typeof showProject>>>(r);
    expect(r.out).not.toMatch(/JOY MEDIA|Project Details/);
    expect(show).toMatchObject({
      id,
      title: 'Machine view',
      revision: 2,
      source: 'sqlite',
      width: 1920,
      height: 1080,
      frameRate: 30,
      assetCount: 0,
    });
    expect(show.tracks.map((t) => t.id)).toEqual(['track-v1', 'track-v2', 'track-a1']);
    expect(show.tracks[1]!.clips).toEqual([
      {
        id: clip.id,
        assetId: 'a-1',
        startUs: 2_000_000,
        durationUs: 6_000_000,
        endUs: 8_000_000,
        sourceInUs: 0,
      },
    ]);
  });

  it('a typo in the project id gives a helpful error and a non-zero exit', async () => {
    const id = await createProject(sb, 'Real one');
    const typo = `${id}x`;
    const r = expectExit(await sb.run(['project', 'show', typo]), 1);
    expect(r.err).toContain(typo);
    expect(r.err).toMatch(/not found/i);
    expect(r.err).toContain('project list');
    expect(r.out.trim(), 'errors never go to stdout').toBe('');
  });

  it('the same typo under --json is a machine-readable error document', async () => {
    await createProject(sb, 'Real one');
    const doc = jsonError(await sb.run(['project', 'show', 'proj-nope', '--json']), 1);
    expect(doc.code).toBe('PROJECT_NOT_FOUND');
    expect(doc.message).toContain('proj-nope');
  });

  it('on a brand-new machine "not found" is explained, is not a crash, and creates nothing', async () => {
    const r = expectExit(await sb.run(['project', 'show', 'proj-abc']), 1);
    expect(r.err).toMatch(/not found/i);
    expect(r.err).not.toMatch(/TypeError|at .*\.js:\d+/);
    expect(existsSync(dbFile())).toBe(false);
  });

  it('accepts the project through the global --project flag as well as positionally', async () => {
    const id = await createProject(sb, 'Flag form');
    for (const args of [
      ['project', 'show', '--project', id, '--json'],
      ['project', 'show', '-p', id, '--json'],
      ['project', 'show', id, '--project', id, '--json'],
    ]) {
      expect(singleJson<{ id: string }>(expectOk(await sb.run(args))).id).toBe(id);
    }
  });

  it('reports a missing, conflicting or surplus id as a usage error (exit 2)', async () => {
    const id = await createProject(sb, 'Usage');
    const cases: Array<[string[], RegExp]> = [
      [['project', 'show'], /Usage: joy-media project show/],
      [['project', 'show', id, '--project', 'proj-other'], /two different projects/i],
      [['project', 'show', 'My', 'Project'], /Unexpected extra argument "Project"/],
    ];
    for (const [args, message] of cases) {
      const r = expectExit(await sb.run(args), 2);
      expect(r.err, describeRun(r)).toMatch(message);
      expect(r.out.trim()).toBe('');
    }
  });

  it('an unknown subcommand is a usage error that names the valid ones', async () => {
    const r = expectExit(await sb.run(['project', 'frobnicate']), 2);
    expect(r.err).toMatch(/Unknown project subcommand: frobnicate/);
    expect(r.err).toMatch(/list, create, show, export, import/);
    expect(r.out.trim(), 'help text is a diagnostic: stderr, not stdout').toBe('');

    const asJson = jsonError(await sb.run(['project', 'frobnicate', '--json']), 2);
    expect(asJson.code).toBe('USAGE');
  });
});

describe('exporting and importing', () => {
  it('writes <id>.json in the working folder by default, and the file is a valid project', async () => {
    const id = await createProject(sb, 'Export me');
    await addClip(sb, id, { duration: 5 });
    const r = expectOk(await sb.run(['project', 'export', id]));
    expect(r.out).toContain(`${id}.json`);
    expect(existsSync(sb.path(`${id}.json`))).toBe(true);
    const exported = await exportAndValidate(sb, id, 'explicit.json');
    expect(exported.revision).toBe(2);
  });

  it('--json reports where it wrote; `--out` is accepted as an alias of --output', async () => {
    const id = await createProject(sb, 'Alias');
    const viaOutput = singleJson<{ id: string; path: string; revision: number }>(
      expectOk(await sb.run(['project', 'export', id, '--output', 'a.json', '--json'])),
    );
    expect(viaOutput).toMatchObject({ id, path: 'a.json', revision: 1 });
    const viaOut = singleJson<{ path: string }>(
      expectOk(await sb.run(['project', 'export', id, '--out', 'b.json', '--json'])),
    );
    expect(viaOut.path).toBe('b.json');
    expect(existsSync(sb.path('a.json')) && existsSync(sb.path('b.json'))).toBe(true);
  });

  it('exporting a mistyped id fails with exit 1 and writes no file', async () => {
    await createProject(sb, 'Real');
    const r = expectExit(await sb.run(['project', 'export', 'proj-nope', '--output', 'x.json']), 1);
    expect(r.err).toMatch(/not found/i);
    expect(existsSync(sb.path('x.json'))).toBe(false);
    expect(readdirSync(sb.cwd)).toEqual([]);
  });

  it('exporting into a folder that does not exist is a clear error, not a stack trace', async () => {
    const id = await createProject(sb, 'No folder');
    const r = expectExit(await sb.run(['project', 'export', id, '--output', 'nodir/x.json']), 1);
    expect(r.err).toMatch(/cannot write nodir\/x\.json: the folder does not exist/i);
    expect(r.err).not.toMatch(/ENOENT/);
  });

  it('re-exporting replaces the file as a whole: no temp files are left behind', async () => {
    const id = await createProject(sb, 'Twice exported');
    expectOk(await sb.run(['project', 'export', id, '--output', 'out.json']));
    await addClip(sb, id, { duration: 2 });
    expectOk(await sb.run(['project', 'export', id, '--output', 'out.json']));
    expect(readdirSync(sb.cwd)).toEqual(['out.json']);
    expect(JSON.parse(readFileSync(sb.path('out.json'), 'utf8')).revision).toBe(2);
  });

  it('a project moves to another machine: export, then import into a fresh HOME', async () => {
    const id = await createProject(sb, 'Travels', ['--width', '1920', '--height', '1080']);
    await addClip(sb, id, { start: 1, duration: 4 });
    expectOk(await sb.run(['project', 'export', id, '--output', 'travel.json']));

    const other = createSandbox('project-other');
    try {
      writeFileSync(other.path('travel.json'), readFileSync(sb.path('travel.json')));
      const imported = singleJson<{ id: string; title: string; revision: number }>(
        expectOk(await other.run(['project', 'import', 'travel.json', '--json'])),
      );
      expect(imported).toMatchObject({ id, title: 'Travels' });

      const there = await showProject(other, id);
      const here = await showProject(sb, id);
      expect(there.tracks).toEqual(here.tracks);
      expect(there).toMatchObject({ title: 'Travels', width: 1920, height: 1080 });
    } finally {
      other.cleanup();
    }
  });

  it('importing an OLDER export over newer work makes the import the newest revision and keeps history', async () => {
    const id = await createProject(sb, 'Rewind');
    expectOk(await sb.run(['project', 'export', id, '--output', 'old.json']));
    await addClip(sb, id, { start: 0, duration: 4 });
    await addClip(sb, id, { start: 5, duration: 4 });
    await addClip(sb, id, { start: 10, duration: 4 });
    expect((await showProject(sb, id)).revision).toBe(4);

    const r = expectOk(await sb.run(['project', 'import', 'old.json', '--json']));
    const imported = singleJson<{ revision: number; replaced: boolean }>(r);
    expect(imported.replaced).toBe(true);
    expect(imported.revision).toBeGreaterThan(4);

    const after = await showProject(sb, id);
    expect(after.revision).toBe(imported.revision);
    expect(
      after.tracks.flatMap((t) => t.clips),
      'the imported (empty) timeline is what `show` reports now',
    ).toEqual([]);
  });

  it('the human import message says when it replaced an existing project', async () => {
    const id = await createProject(sb, 'Replace me');
    expectOk(await sb.run(['project', 'export', id, '--output', 'again.json']));
    const r = expectOk(await sb.run(['project', 'import', 'again.json']));
    expect(r.out).toMatch(/Imported project Replace me/);
    expect(r.out).toMatch(/replaced the existing project/);
  });

  it('migrates every historical schema to v3 and preserves its timeline after save and fresh-process reopen', async () => {
    const historical = buildHistoricalSchemaProjects();
    let previousRevision = 0;

    for (const [label, project] of Object.entries(historical)) {
      const inputPath = `historical-${label}.json`;
      const outputPath = `roundtrip-${label}.json`;
      writeFileSync(sb.path(inputPath), JSON.stringify(project));

      const imported = singleJson<{ id: string; revision: number }>(
        expectOk(await sb.run(['project', 'import', inputPath, '--json'])),
      );
      expect(imported.id).toBe('historical-schemas');
      expect(imported.revision).toBe(previousRevision + 1);
      previousRevision = imported.revision;

      const reopened = await showProject(sb, imported.id);
      expect(reopened).toMatchObject({
        id: 'historical-schemas',
        title: 'Historical Schema Versions',
        revision: imported.revision,
      });
      expect(reopened.tracks[0]?.clips).toMatchObject([
        {
          id: 'clip-video',
          startUs: 0,
          durationUs: 5_000_000,
          assetId: 'asset-video',
        },
      ]);

      expectOk(await sb.run(['project', 'export', imported.id, '--output', outputPath]));
      const exported = JSON.parse(readFileSync(sb.path(outputPath), 'utf8')) as {
        source: { schemaVersion: number; id: string; title: string };
      };
      expect(exported.source).toMatchObject({
        schemaVersion: 3,
        id: 'historical-schemas',
        title: 'Historical Schema Versions',
      });
    }
  });

  it('rejects malformed, dangling, and cyclic projects without writing files or profile data', async () => {
    const historical = buildHistoricalSchemaProjects();
    const malformed = structuredClone(historical.v1);
    Object.assign(malformed, { title: '' });

    const dangling = structuredClone(historical.v1);
    const tracks = dangling.compositions[dangling.rootCompositionId]!
      .tracks as unknown as unknown[];
    tracks.push({
      id: 'caption-track',
      kind: 'caption',
      name: 'Captions',
      order: 1,
      enabled: true,
      locked: false,
      clips: [
        {
          id: 'dangling-caption',
          kind: 'caption',
          startUs: 0,
          durationUs: 1_000_000,
          captionDocumentId: 'missing-document',
        },
      ],
    });

    const cyclic = structuredClone(historical.v1);
    const transform = {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotationDeg: 0,
      opacity: 1,
      crop: { left: 0, top: 0, right: 0, bottom: 0 },
    };
    Object.assign(cyclic, {
      visualObjects: {
        a: { id: 'a', kind: 'null', transform, parentId: 'b' },
        b: { id: 'b', kind: 'null', transform, parentId: 'a' },
      },
    });

    for (const [label, project] of [
      ['malformed', malformed],
      ['dangling', dangling],
      ['cyclic', cyclic],
    ] as const) {
      const path = `${label}.json`;
      writeFileSync(sb.path(path), JSON.stringify(project));
      const before = readFileSync(sb.path(path), 'utf8');

      const result = await sb.run(['project', 'import', path, '--json']);

      const error = jsonError(result, 1);
      expect(error.code, label).toBe('PROJECT_FILE_INVALID');
      expect(readFileSync(sb.path(path), 'utf8'), label).toBe(before);
      expect(existsSync(dbFile()), label).toBe(false);
    }
  });

  it('rejects a future schema on import without changing the file or stored projects', async () => {
    const safeId = await createProject(sb, 'Safe existing project');
    expectOk(await sb.run(['project', 'export', safeId, '--output', 'future-schema.json']));

    const projectFile = sb.path('future-schema.json');
    const parsed = JSON.parse(readFileSync(projectFile, 'utf8')) as {
      source: { schemaVersion: number };
    };
    parsed.source.schemaVersion = 99;
    writeFileSync(projectFile, JSON.stringify(parsed, null, 2));
    const beforeFile = readFileSync(projectFile, 'utf8');
    const beforeProjects = JSON.stringify(await listProjects(sb));

    const result = await sb.run(['project', 'import', 'future-schema.json', '--json']);

    const error = jsonError(result, 1);
    expect(error.code).toBe('PROJECT_SCHEMA_UNSUPPORTED');
    expect(error.message).toMatch(/schema version 99/i);
    expect(readFileSync(projectFile, 'utf8')).toBe(beforeFile);
    expect(JSON.stringify(await listProjects(sb))).toBe(beforeProjects);
    expect((await showProject(sb, safeId)).revision).toBe(1);
  });

  it('importing a file that does not exist says so (not "Usage"), and with no file is a usage error', async () => {
    const missing = expectExit(await sb.run(['project', 'import', 'nope.json']), 1);
    expect(missing.err).toMatch(/File not found: nope\.json/);
    expect(missing.err).not.toMatch(/Usage/);
    const bare = expectExit(await sb.run(['project', 'import']), 2);
    expect(bare.err).toMatch(/Usage: joy-media project import/);
  });

  it.each([
    ['not JSON at all', '{this is not json', /not valid JSON/],
    ['an unrelated JSON object', '{"hello": 1}', /not a JOY Media project file/],
    ['a JSON array', '[1, 2, 3]', /not a JOY Media project file/],
    ['an empty file', '', /not valid JSON/],
  ])('refuses %s, naming the file, and leaves the database untouched', async (_l, content, msg) => {
    const id = await createProject(sb, 'Safe');
    const before = JSON.stringify(await listProjects(sb));
    writeFileSync(sb.path('bad.json'), content);

    const r = expectExit(await sb.run(['project', 'import', 'bad.json']), 1);
    expect(r.err).toContain('bad.json');
    expect(r.err).toMatch(msg);
    expect(r.err).not.toMatch(/TypeError|undefined/);
    expect(JSON.stringify(await listProjects(sb))).toBe(before);
    expect((await showProject(sb, id)).revision).toBe(1);
  });

  it('importing a folder is a clean error', async () => {
    mkdirSync(sb.path('adir'));
    const r = expectExit(await sb.run(['project', 'import', 'adir']), 1);
    expect(r.err).toMatch(/Cannot read .*adir/);
  });
});

describe('a project addressed by id versus by file.json', () => {
  it('shows an exported file directly, and the file and the database copy are independent', async () => {
    const id = await createProject(sb, 'Two homes');
    expectOk(await sb.run(['project', 'export', id, '--output', 'copy.json']));

    const fromFile = await showProject(sb, 'copy.json');
    expect(fromFile).toMatchObject({ id, title: 'Two homes', source: 'file' });

    // Editing the file does not touch the database copy, and vice versa.
    await addClip(sb, 'copy.json', { duration: 3 });
    expect((await showProject(sb, 'copy.json')).tracks[0]!.clips).toHaveLength(1);
    expect((await showProject(sb, id)).tracks[0]!.clips).toHaveLength(0);
  });

  it('rejects a future project schema before editing and leaves the file byte-for-byte intact', async () => {
    const id = await createProject(sb, 'Future schema');
    expectOk(await sb.run(['project', 'export', id, '--output', 'future.json']));
    const projectFile = sb.path('future.json');
    const parsed = JSON.parse(readFileSync(projectFile, 'utf8')) as {
      source: { schemaVersion: number };
    };
    parsed.source.schemaVersion = 99;
    writeFileSync(projectFile, JSON.stringify(parsed, null, 2));
    const before = readFileSync(projectFile, 'utf8');

    const result = await sb.run([
      'timeline',
      'add-clip',
      '--project',
      'future.json',
      '--duration',
      '2',
      '--json',
    ]);

    const error = jsonError(result, 1);
    expect(error.code).toBe('PROJECT_SCHEMA_UNSUPPORTED');
    expect(error.message).toMatch(/schema version 99/i);
    expect(readFileSync(projectFile, 'utf8')).toBe(before);
  });

  it('a process killed before export rename preserves the old file and a retry removes its temp', async () => {
    const id = await createProject(sb, 'Atomic export');
    expectOk(await sb.run(['project', 'export', id, '--output', 'atomic.json']));
    const target = sb.path('atomic.json');
    const priorBytes = readFileSync(target);
    const marker = sb.path('file-rename-paused.json');

    const killed = await sb.run(['project', 'export', id, '--output', 'atomic.json', '--json'], {
      env: persistenceFaultEnv('before-file-rename', marker, target),
      signal: 'SIGKILL',
      signalAfterMs: 3_000,
      timeoutMs: 15_000,
    });

    expect(killed.timedOut, describeRun(killed)).toBe(false);
    expect(killed.code, describeRun(killed)).not.toBe(0);
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toMatchObject({ mode: 'before-file-rename' });
    expect(readFileSync(target)).toEqual(priorBytes);
    const abandonedTemps = readdirSync(sb.cwd).filter(
      (name) => name.startsWith('atomic.json.') && name.endsWith('.tmp'),
    );
    expect(abandonedTemps).toHaveLength(1);

    expectOk(await sb.run(['project', 'export', id, '--output', 'atomic.json']));
    expect(JSON.parse(readFileSync(target, 'utf8'))).toMatchObject({ id, title: 'Atomic export' });
    expect(
      readdirSync(sb.cwd).filter(
        (name) => name.startsWith('atomic.json.') && name.endsWith('.tmp'),
      ),
    ).toHaveLength(0);
  }, 30_000);

  it('a folder that happens to be named like the project id does not break lookup by id', async () => {
    const id = await createProject(sb, 'Name clash');
    mkdirSync(sb.path(id));
    expect((await showProject(sb, id)).id).toBe(id);
  });

  it('a missing .json file is "not found", not an ENOENT dump', async () => {
    const r = expectExit(await sb.run(['project', 'show', 'missing.json']), 1);
    expect(r.err).toMatch(/Project file not found: missing\.json/);
    expect(r.err).not.toMatch(/ENOENT/);
  });

  it.each([
    ['broken JSON', '{not json', /not valid JSON/],
    ['a JSON array', '[1,2]', /not a JOY Media project file/],
    ['an object that is not a project', '{"id":"x"}', /not a JOY Media project file/],
  ])('%s is reported by name, never as a TypeError', async (_label, content, message) => {
    writeFileSync(sb.path('weird.json'), content);
    const r = expectExit(await sb.run(['project', 'show', 'weird.json']), 1);
    expect(r.err).toContain('weird.json');
    expect(r.err).toMatch(message);
    expect(r.err).not.toMatch(/TypeError/);
    expect(readFileSync(sb.path('weird.json'), 'utf8')).toBe(content);
  });
});
