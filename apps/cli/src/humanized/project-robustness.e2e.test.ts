/**
 * What happens to projects when the world is not tidy: several processes at once
 * (an agent fanning out tool calls), a damaged or missing database, an odd HOME,
 * a custom database location. The contract: never lose or half-write data, and
 * always say what went wrong and where.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  utimesSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLI_ROOT, createSandbox, describeRun, type Sandbox } from './harness.js';
import {
  addClip,
  persistenceFaultEnv,
  createProject,
  defaultProjectDbPath,
  expectExit,
  expectOk,
  isRoot,
  jsonError,
  listProjects,
  SEC,
  showProject,
  singleJson,
  spans,
  track,
} from './project-helpers.js';

vi.setConfig({ testTimeout: 90_000 });

let sb: Sandbox;
beforeEach(() => {
  sb = createSandbox('robust');
});
afterEach(() => sb.cleanup());

const defaultDb = (): string => defaultProjectDbPath(sb);

describe('several processes at once (an agent fanning out tool calls)', () => {
  it('a separate SQLite writer lock returns a bounded busy error and retry keeps revisions monotonic', async () => {
    const id = await createProject(sb, 'Held database lock');
    const marker = sb.path('sqlite-lock-held.json');
    const lockHolder = spawn(
      process.execPath,
      [
        join(CLI_ROOT, 'src', 'humanized', 'fixtures', 'sqlite-lock-holder.mjs'),
        defaultDb(),
        marker,
      ],
      { cwd: sb.cwd, env: sb.env(), stdio: 'ignore' },
    );
    const lockHolderClosed = new Promise<void>((resolvePromise) => {
      lockHolder.once('close', () => resolvePromise());
    });

    try {
      await expect.poll(() => existsSync(marker), { timeout: 10_000 }).toBe(true);
      const blocked = await sb.run(
        ['timeline', 'add-clip', '--project', id, '--duration', '4', '--json'],
        { timeoutMs: 20_000 },
      );
      const error = jsonError(blocked, 1);
      expect(error.code).toBe('DATABASE_BUSY');
      expect(error.message).toMatch(/busy.*Try again/i);
      expect(spans(await showProject(sb, id))).toEqual([]);
      expect((await showProject(sb, id)).revision).toBe(1);

      lockHolder.kill('SIGKILL');
      await lockHolderClosed;
      await addClip(sb, id, { duration: 4 });
      expect(spans(await showProject(sb, id))).toEqual([[0, 4]]);
      expect((await showProject(sb, id)).revision).toBe(2);
    } finally {
      if (lockHolder.exitCode === null && lockHolder.signalCode === null) {
        lockHolder.kill('SIGKILL');
      }
      await lockHolderClosed;
    }
  }, 40_000);

  it('a process killed before SQLite COMMIT leaves the previous complete revision recoverable', async () => {
    const id = await createProject(sb, 'Crash before commit');
    const marker = sb.path('sqlite-commit-paused.json');
    const killed = await sb.run(
      ['timeline', 'add-clip', '--project', id, '--duration', '4', '--json'],
      {
        env: persistenceFaultEnv('before-sqlite-commit', marker),
        signal: 'SIGKILL',
        signalAfterMs: 3_000,
        timeoutMs: 15_000,
      },
    );

    expect(killed.timedOut, describeRun(killed)).toBe(false);
    expect(killed.code, describeRun(killed)).not.toBe(0);
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toMatchObject({
      mode: 'before-sqlite-commit',
    });
    expect(await showProject(sb, id)).toMatchObject({ revision: 1, tracks: expect.any(Array) });
    expect(spans(await showProject(sb, id))).toEqual([]);

    await addClip(sb, id, { duration: 4 });
    expect(await showProject(sb, id)).toMatchObject({ revision: 2 });
    expect(spans(await showProject(sb, id))).toEqual([[0, 4]]);
  }, 30_000);

  it('SQLite SQLITE_FULL at commit keeps the old revision and returns a stable error', async () => {
    const id = await createProject(sb, 'Full database');
    const marker = sb.path('sqlite-full-injected.json');
    const failed = await sb.run(
      ['timeline', 'add-clip', '--project', id, '--duration', '4', '--json'],
      { env: persistenceFaultEnv('sqlite-full-commit', marker) },
    );

    const error = jsonError(failed, 1);
    expect(error.code).toBe('DATABASE_FULL');
    expect(error.message).toMatch(/is full.*Free disk space/i);
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toMatchObject({ mode: 'sqlite-full-commit' });
    expect(spans(await showProject(sb, id))).toEqual([]);
    expect((await showProject(sb, id)).revision).toBe(1);

    await addClip(sb, id, { duration: 4 });
    expect(spans(await showProject(sb, id))).toEqual([[0, 4]]);
  });

  it('parallel file-project imports retain every source registration and render after restart', async () => {
    const sources = [
      'readiness-hard-cut.mkv',
      'readiness-silent.mp4',
      'readiness-odd-161x91.mkv',
      'readiness-vfr.mkv',
      'readiness-rotation.mp4',
      'readiness-ntsc-30000-1001.mp4',
    ].map((name) => resolve(CLI_ROOT, '..', '..', 'packages', 'test-fixtures', 'media', name));
    const projects: string[] = [];
    for (let index = 0; index < sources.length; index++) {
      const id = await createProject(sb, `File registration ${index + 1}`);
      const path = sb.path(`file-project-${index + 1}.json`);
      const exported = await sb.run(['project', 'export', id, '--output', path, '--json']);
      expect(exported.code, describeRun(exported)).toBe(0);
      projects.push(path);
    }

    const added = await Promise.all(
      projects.map((project, index) =>
        sb.run([
          'timeline',
          'add-clip',
          '--project',
          project,
          '--asset',
          sources[index]!,
          '--json',
        ]),
      ),
    );
    for (const result of added) expect(result.code, describeRun(result)).toBe(0);

    const sourceMapPath = join(sb.joyDir, 'cli-asset-sources.json');
    const sourceMap = JSON.parse(readFileSync(sourceMapPath, 'utf8')) as Record<string, string>;
    const assetIds = await Promise.all(
      projects.map(async (project) => {
        const shown = await showProject(sb, project);
        return shown.tracks.flatMap((item) => item.clips).map((clip) => clip.assetId!)[0]!;
      }),
    );
    for (const [index, assetId] of assetIds.entries()) {
      expect(sourceMap[assetId], `missing source registration ${assetId}`).toBe(sources[index]);
    }

    const renders = await Promise.all(
      projects.map((project, index) =>
        sb.run([
          'render',
          '--project',
          project,
          '--out',
          sb.path(`fresh-render-${index}`),
          '--json',
        ]),
      ),
    );
    for (const result of renders) {
      expect(result.code, describeRun(result)).toBe(0);
      expect(result.ndjson<{ type: string; mediaProduced?: boolean }>().at(-1)).toMatchObject({
        type: 'complete',
        mediaProduced: true,
      });
    }
  }, 120_000);

  it('eight parallel `project create` calls all succeed and make eight distinct projects', async () => {
    const names = Array.from({ length: 8 }, (_, i) => `Parallel ${i + 1}`);
    const results = await Promise.all(
      names.map((name) => sb.run(['project', 'create', name, '--json'])),
    );
    for (const r of results) expect(r.code, describeRun(r)).toBe(0);
    const ids = results.map((r) => singleJson<{ id: string }>(r).id);
    expect(new Set(ids).size, 'every project got its own id').toBe(8);

    const listed = await listProjects(sb);
    expect(listed.map((p) => p.title).sort()).toEqual([...names].sort());
  });

  it('six parallel add-clip calls on one project all succeed and none is lost', async () => {
    const id = await createProject(sb, 'Fan out');
    const results = await Promise.all(
      [1, 2, 3, 4, 5, 6].map((i) =>
        sb.run([
          'timeline',
          'add-clip',
          '--project',
          id,
          '--start',
          String(i * 10),
          '--duration',
          '5',
          '--json',
        ]),
      ),
    );
    for (const r of results) expect(r.code, describeRun(r)).toBe(0);

    const revisions = results.map((r) => singleJson<{ revision: number }>(r).revision);
    expect([...revisions].sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7]);

    const show = await showProject(sb, id);
    expect(show.revision).toBe(7);
    expect(spans(show)).toEqual([10, 20, 30, 40, 50, 60].map((s) => [s, s + 5]));
    const ids = track(show, 'track-v1').clips.map((c) => c.id);
    expect(new Set(ids).size, 'clip ids are unique').toBe(6);
  });

  it('different edits at the same moment (split, trim, remove, add) are all applied', async () => {
    const id = await createProject(sb, 'Mixed');
    const a = await addClip(sb, id, { start: 1, duration: 10 });
    const b = await addClip(sb, id, { start: 20, duration: 10 });
    const c = await addClip(sb, id, { start: 40, duration: 10 });

    const results = await Promise.all([
      sb.run(['timeline', 'split', '--project', id, '--clip', a.id, '--at', '6', '--json']),
      sb.run(['timeline', 'trim', '--project', id, '--clip', b.id, '--end', '25', '--json']),
      sb.run(['timeline', 'remove-clip', '--project', id, '--clip', c.id, '--json']),
      sb.run([
        'timeline',
        'add-clip',
        '--project',
        id,
        '--start',
        '60',
        '--duration',
        '3',
        '--json',
      ]),
    ]);
    for (const r of results) expect(r.code, describeRun(r)).toBe(0);

    const show = await showProject(sb, id);
    expect(show.revision).toBe(4 + 4);
    expect(spans(show)).toEqual([
      [1, 6],
      [6, 11],
      [20, 25],
      [60, 63],
    ]);
  });

  it('two processes racing for the same slot: exactly one wins, the other is told it overlaps', async () => {
    const id = await createProject(sb, 'Race');
    const run = (): ReturnType<Sandbox['run']> =>
      sb.run([
        'timeline',
        'add-clip',
        '--project',
        id,
        '--start',
        '5',
        '--duration',
        '5',
        '--json',
      ]);
    const results = await Promise.all([run(), run()]);

    expect(results.map((r) => r.code).sort()).toEqual([0, 1]);
    const loser = results.find((r) => r.code === 1)!;
    expect(jsonError(loser, 1).code).toBe('CLIP_OVERLAP');

    const show = await showProject(sb, id);
    expect(spans(show)).toEqual([[5, 10]]);
    expect(show.revision).toBe(2);
  });

  it('readers are never blocked or broken while writers are busy', async () => {
    const id = await createProject(sb, 'Busy');
    const writers = [1, 2, 3, 4].map((i) =>
      sb.run([
        'timeline',
        'add-clip',
        '--project',
        id,
        '--start',
        String(i * 10),
        '--duration',
        '2',
      ]),
    );
    const readers = [1, 2, 3, 4].map(() => sb.run(['project', 'list', '--json']));
    const showers = [1, 2].map(() => sb.run(['project', 'show', id, '--json']));
    const all = await Promise.all([...writers, ...readers, ...showers]);
    for (const r of all) {
      expect(r.code, describeRun(r)).toBe(0);
      expect(r.err).not.toMatch(/locked|busy/i);
    }
    for (const r of all.slice(writers.length)) singleJson(r);
  });

  it('the lock is released afterwards: no lock folder is left next to the database', async () => {
    const id = await createProject(sb, 'Tidy');
    await addClip(sb, id, { duration: 2 });
    expect(readdirSync(dirname(defaultDb())).filter((name) => name.endsWith('.lock'))).toEqual([]);
  });

  it('a lock left behind by a killed process does not block editing forever', async () => {
    const id = await createProject(sb, 'Stale lock');
    const lock = `${defaultDb()}.lock`;
    mkdirSync(lock);
    const longAgo = new Date(Date.now() - 10 * 60_000);
    utimesSync(lock, longAgo, longAgo);

    const added = await addClip(sb, id, { duration: 4 });
    expect(added.durationUs).toBe(4 * SEC);
    expect(existsSync(lock), 'the stale lock was taken over and released').toBe(false);
  });
});

describe('a damaged database', () => {
  const garbage = 'this is not a sqlite database\n';

  it.each([
    ['plain text where the database should be', () => garbage],
    ['a zero-filled file', () => '\0'.repeat(8192)],
  ])(
    '%s: every command refuses cleanly, names the file, and leaves it untouched',
    async (_l, makeBytes) => {
      mkdirSync(dirname(defaultDb()), { recursive: true });
      writeFileSync(defaultDb(), makeBytes());
      const before = readFileSync(defaultDb());

      for (const args of [
        ['project', 'list'],
        ['project', 'create', 'Victim'],
        ['project', 'show', 'proj-x'],
        ['project', 'export', 'proj-x'],
        ['timeline', 'add-clip', '--project', 'proj-x'],
      ]) {
        const r = expectExit(await sb.run(args), 1);
        expect(r.err, describeRun(r)).toContain(defaultDb());
        expect(r.err, describeRun(r)).toMatch(/corrupted or is not a SQLite file/);
        expect(r.err).toMatch(/--sqlite-path/);
        expect(r.err).not.toMatch(/TypeError|at .*\.js:\d+/);
        expect(r.out.trim()).toBe('');
      }
      expect(readFileSync(defaultDb()).equals(before), 'the damaged file was not modified').toBe(
        true,
      );
    },
  );

  it('under --json the failure is an error document with a stable code', async () => {
    mkdirSync(dirname(defaultDb()), { recursive: true });
    writeFileSync(defaultDb(), garbage);
    const doc = jsonError(await sb.run(['project', 'list', '--json']), 1);
    expect(doc.code).toBe('DATABASE_CORRUPT');
    expect(doc.message).toContain(defaultDb());
  });

  it('a truncated real database is reported, not crashed on, and not modified', async () => {
    await createProject(sb, 'Will be truncated');
    const whole = readFileSync(defaultDb());
    writeFileSync(defaultDb(), whole.subarray(0, 100));
    const before = readFileSync(defaultDb());

    const r = expectExit(await sb.run(['project', 'list']), 1);
    expect(r.err).toMatch(/corrupted or is not a SQLite file/);
    expect(readFileSync(defaultDb()).equals(before)).toBe(true);
  });

  it('an empty (0 byte) database file is simply a new database', async () => {
    mkdirSync(dirname(defaultDb()), { recursive: true });
    writeFileSync(defaultDb(), '');
    expect(await listProjects(sb)).toEqual([]);
    const id = await createProject(sb, 'Fresh start');
    expect((await showProject(sb, id)).title).toBe('Fresh start');
  });

  it('a database that is really a folder is a clear error', async () => {
    mkdirSync(defaultDb(), { recursive: true });
    const r = expectExit(await sb.run(['project', 'create', 'Nope']), 1);
    expect(r.err).toContain(defaultDb());
    expect(r.err).toMatch(/not readable and writable|corrupted/);
  });

  it('a SQLite file from some other program is not a project list (and is not written to by listing)', async () => {
    mkdirSync(dirname(defaultDb()), { recursive: true });
    const other = new DatabaseSync(defaultDb());
    other.exec('CREATE TABLE notes (body TEXT)');
    other.close();
    expect(await listProjects(sb)).toEqual([]);

    const check = new DatabaseSync(defaultDb(), { readOnly: true });
    try {
      const tables = check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
      expect(tables).toEqual([{ name: 'notes' }]);
    } finally {
      check.close();
    }
  });

  describe('a single unreadable project among healthy ones', () => {
    async function seed(): Promise<string> {
      const healthy = await createProject(sb, 'Healthy');
      const db = new DatabaseSync(defaultDb());
      const insert = db.prepare(
        'INSERT INTO snapshots (project_id, revision, schema_version, payload, checksum) VALUES (?, 1, 1, ?, ?)',
      );
      insert.run('proj-garbage', '{not json', 'x');
      insert.run('proj-odd', '{"id":"proj-odd"}', 'x');
      db.close();
      return healthy;
    }

    it('listing still works and says which project it had to skip', async () => {
      const healthy = await seed();
      const r = expectOk(await sb.run(['project', 'list', '--json']));
      const ids = singleJson<Array<{ id: string }>>(r).map((p) => p.id);
      expect(ids).toContain(healthy);
      expect(ids).not.toContain('proj-garbage');
      expect(r.err).toMatch(/Skipped project "proj-garbage"/);
    });

    it.each([
      ['project', 'show'],
      ['timeline', 'add-clip'],
    ])('`%s %s` names the broken project instead of crashing on undefined', async (a, b) => {
      await seed();
      for (const [id, message] of [
        ['proj-garbage', /stored data of project "proj-garbage" .* is unreadable/],
        ['proj-odd', /stored copy of project "proj-odd" is not a JOY Media project/],
      ] as const) {
        const args = a === 'project' ? [a, b, id] : [a, b, '--project', id];
        const r = expectExit(await sb.run(args), 1);
        expect(r.err, describeRun(r)).toMatch(message);
        expect(r.err).not.toMatch(/TypeError|undefined/);
      }
    });
  });

  it.skipIf(isRoot)('a read-only database says so and writes nothing', async () => {
    const id = await createProject(sb, 'Locked down');
    chmodSync(defaultDb(), 0o444);
    const r = expectExit(await sb.run(['timeline', 'add-clip', '--project', id]), 1);
    expect(r.err).toMatch(/read-only/);
    expect((await showProject(sb, id)).revision).toBe(1);
  });
});

describe('where the database lives', () => {
  it('--sqlite-path keeps a project out of the default database, and every command honours it', async () => {
    const custom = sb.path('work', 'projects.sqlite3');
    mkdirSync(sb.path('work'));
    const created = singleJson<{ id: string; sqlitePath: string }>(
      expectOk(await sb.run(['project', 'create', 'Elsewhere', '--sqlite-path', custom, '--json'])),
    );
    expect(created.sqlitePath).toBe(custom);
    expect(existsSync(custom)).toBe(true);
    expect(existsSync(defaultDb()), 'the default database was not touched').toBe(false);

    const withFlag = ['--sqlite-path', custom];
    expect((await listProjects(sb, withFlag)).map((p) => p.id)).toEqual([created.id]);
    expect(await listProjects(sb)).toEqual([]);

    const clip = await addClip(sb, created.id, { duration: 3 }, withFlag);
    expect(clip.durationUs).toBe(3 * SEC);
    expect((await showProject(sb, created.id, withFlag)).revision).toBe(2);

    // Without the flag the project is, correctly, unknown.
    expectExit(await sb.run(['project', 'show', created.id]), 1);
  });

  it('a relative --sqlite-path is relative to where the command runs, and is reported as absolute', async () => {
    const created = singleJson<{ sqlitePath: string }>(
      expectOk(
        await sb.run(['project', 'create', 'Relative', '--sqlite-path', 'here.sqlite3', '--json']),
      ),
    );
    expect(created.sqlitePath).toBe(sb.path('here.sqlite3'));
    expect(statSync(sb.path('here.sqlite3')).isFile()).toBe(true);
  });

  it('JOY_MEDIA_SQLITE_PATH picks the database, and --sqlite-path beats it', async () => {
    const fromEnv = sb.path('env.sqlite3');
    const fromFlag = sb.path('flag.sqlite3');
    const env = { JOY_MEDIA_SQLITE_PATH: fromEnv };

    const a = await createProject(sb, 'Via env', [], { env });
    expect(existsSync(fromEnv)).toBe(true);
    expect(existsSync(defaultDb())).toBe(false);
    expect((await showProject(sb, a, [], { env })).title).toBe('Via env');

    const b = await createProject(sb, 'Via flag', ['--sqlite-path', fromFlag], { env });
    expect(existsSync(fromFlag)).toBe(true);
    expect((await listProjects(sb, [], { env })).map((p) => p.id)).toEqual([a]);
    expect((await listProjects(sb, ['--sqlite-path', fromFlag], { env })).map((p) => p.id)).toEqual(
      [b],
    );
  });

  it('the sqlitePath from ~/.joy-media/cli-config.json is used when nothing else is given', async () => {
    const configured = sb.path('configured.sqlite3');
    mkdirSync(sb.joyDir, { recursive: true });
    writeFileSync(join(sb.joyDir, 'cli-config.json'), JSON.stringify({ sqlitePath: configured }));
    await createProject(sb, 'Configured');
    expect(existsSync(configured)).toBe(true);
    expect(existsSync(defaultDb())).toBe(false);
  });

  it('a --sqlite-path in a folder that does not exist is a clear error and creates nothing', async () => {
    const target = sb.path('no', 'such', 'dir', 'x.sqlite3');
    const r = expectExit(
      await sb.run(['project', 'create', 'Lost', '--sqlite-path', target, '--json']),
      1,
    );
    const doc = jsonError(r, 1);
    expect(doc.code).toBe('DATABASE_UNAVAILABLE');
    expect(doc.message).toContain(target);
    expect(doc.message).toMatch(/folder .* does not exist/);
    expect(existsSync(sb.path('no'))).toBe(false);
  });

  it('listing against a database that does not exist yet is an empty list, not an error', async () => {
    const r = expectOk(
      await sb.run(['project', 'list', '--json', '--sqlite-path', sb.path('new.sqlite3')]),
    );
    expect(singleJson<unknown[]>(r)).toEqual([]);
    expect(existsSync(sb.path('new.sqlite3'))).toBe(false);
  });

  it('a HOME that cannot hold ~/.joy-media gives an actionable error on create, and an empty list otherwise', async () => {
    const homeIsAFile = sb.path('i-am-a-file');
    writeFileSync(homeIsAFile, 'not a folder');
    const env = {
      HOME: homeIsAFile,
      USERPROFILE: homeIsAFile,
      APPDATA: join(homeIsAFile, 'AppData', 'Roaming'),
    };

    const created = expectExit(await sb.run(['project', 'create', 'Nowhere'], { env }), 1);
    expect(created.err).toMatch(/Cannot open the project database/);
    expect(created.err).toMatch(/--sqlite-path/);
    expect(created.err).not.toMatch(/TypeError|at .*\.js:\d+/);

    const listed = expectOk(await sb.run(['project', 'list', '--json'], { env }));
    expect(singleJson<unknown[]>(listed)).toEqual([]);
  });
});

describe.each(['bin', 'bundle'] as const)('the %s entry point', (entry) => {
  it('runs the whole creator story identically', async () => {
    const run = (args: string[]): ReturnType<Sandbox['run']> => sb.run(args, { entry });

    const created = singleJson<{ id: string; title: string }>(
      expectOk(
        await run([
          'project',
          'create',
          '--name',
          'Story',
          '--width',
          '1920',
          '--height',
          '1080',
          '--json',
        ]),
      ),
    );
    expect(created.title).toBe('Story');
    const id = created.id;

    const added = singleJson<{ clip: { id: string } }>(
      expectOk(await run(['timeline', 'add-clip', '--project', id, '--duration', '30', '--json'])),
    );
    const cut = singleJson<{ clips: Array<{ id: string }> }>(
      expectOk(
        await run([
          'timeline',
          'split',
          '--project',
          id,
          '--clip',
          added.clip.id,
          '--at',
          '10',
          '--json',
        ]),
      ),
    );
    expectOk(
      await run(['timeline', 'trim', '--project', id, '--clip', cut.clips[1]!.id, '--end', '25']),
    );

    const show = singleJson<Awaited<ReturnType<typeof showProject>>>(
      expectOk(await run(['project', 'show', id, '--json'])),
    );
    expect(show).toMatchObject({ title: 'Story', revision: 4, width: 1920, height: 1080 });
    expect(spans(show)).toEqual([
      [0, 10],
      [10, 25],
    ]);

    const list = singleJson<Array<{ id: string; clipCount: number }>>(
      expectOk(await run(['project', 'list', '--json'])),
    );
    expect(list).toMatchObject([{ id, clipCount: 2 }]);

    const missing = jsonError(await run(['project', 'show', 'proj-nope', '--json']), 1);
    expect(missing.code).toBe('PROJECT_NOT_FOUND');
  });
});
