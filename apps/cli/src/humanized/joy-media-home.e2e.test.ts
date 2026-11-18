/**
 * `JOY_MEDIA_HOME` moves the project database as well as the provider settings. Every test runs the real
 * binary with JOY_MEDIA_HOME set to one temp folder and APPDATA pointed at another, so a database that still
 * lands under APPDATA, or in the real home folder, fails the test.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSandbox, describeRun, type Sandbox } from './harness.js';
import {
  createProject,
  defaultProjectDbPath,
  expectOk,
  listProjects,
  singleJson,
} from './project-helpers.js';

vi.setConfig({ testTimeout: 60_000 });

let sb: Sandbox;
let joyHome: string;
let fakeAppData: string;

beforeEach(() => {
  sb = createSandbox('joy-home');
  joyHome = mkdtempSync(join(tmpdir(), 'joy-home-data-'));
  fakeAppData = mkdtempSync(join(tmpdir(), 'joy-home-appdata-'));
});

afterEach(() => {
  sb.cleanup();
  rmSync(joyHome, { recursive: true, force: true });
  rmSync(fakeAppData, { recursive: true, force: true });
});

/** The one switch: every run in these tests gets this environment. */
const switched = (): Record<string, string> => ({ JOY_MEDIA_HOME: joyHome, APPDATA: fakeAppData });
const expectedDb = (): string => join(joyHome, 'desktop', 'joy-media.sqlite3');
const appDataDb = (): string => join(fakeAppData, '@joy-media', 'desktop', 'joy-media.sqlite3');

describe('JOY_MEDIA_HOME moves the project database', () => {
  it('creates the project under JOY_MEDIA_HOME and nothing under APPDATA or the home folder', async () => {
    const r = expectOk(
      await sb.run(['project', 'create', 'Kept at home', '--json'], { env: switched() }),
    );

    expect(singleJson<{ sqlitePath: string }>(r).sqlitePath).toBe(expectedDb());
    expect(existsSync(expectedDb()), describeRun(r)).toBe(true);
    expect(existsSync(appDataDb())).toBe(false);
    expect(existsSync(join(sb.joyDir, 'joy-media.sqlite3'))).toBe(false);
    expect(existsSync(defaultProjectDbPath(sb))).toBe(false);
  });

  it('a later command with the same switch reads that same database', async () => {
    const id = await createProject(sb, 'Second visit', [], { env: switched() });

    const projects = await listProjects(sb, [], { env: switched() });
    expect(projects.map((project) => project.id)).toContain(id);
    expect(existsSync(appDataDb())).toBe(false);
  });

  it('an explicit --sqlite-path still wins over JOY_MEDIA_HOME', async () => {
    const flagDb = sb.path('flag-data', 'flag.sqlite3');
    mkdirSync(sb.path('flag-data'), { recursive: true });

    const r = expectOk(
      await sb.run(['project', 'create', 'Flagged', '--sqlite-path', flagDb, '--json'], {
        env: switched(),
      }),
    );

    expect(singleJson<{ sqlitePath: string }>(r).sqlitePath).toBe(resolve(flagDb));
    expect(existsSync(flagDb), describeRun(r)).toBe(true);
    expect(existsSync(expectedDb())).toBe(false);
  });

  it.skipIf(process.platform !== 'win32')(
    'a blank JOY_MEDIA_HOME is treated as unset and the APPDATA default applies',
    async () => {
      const r = expectOk(
        await sb.run(['project', 'create', 'Blank switch', '--json'], {
          env: { JOY_MEDIA_HOME: '   ', APPDATA: fakeAppData },
        }),
      );

      expect(singleJson<{ sqlitePath: string }>(r).sqlitePath).toBe(appDataDb());
      expect(existsSync(appDataDb())).toBe(true);
    },
  );

  it('doctor names the database in use and its source, and creates nothing', async () => {
    const r = expectOk(
      await sb.run(['doctor', '--json'], { env: { ...switched(), JOY_MEDIA_EDGE_URL: 'off' } }),
    );

    expect(r.json<{ dataLocation: unknown }>().dataLocation).toEqual({
      path: expectedDb(),
      source: 'JOY_MEDIA_HOME',
    });
    expect(existsSync(expectedDb())).toBe(false);
  });

  it('doctor prints the data location on its human-readable output too', async () => {
    const r = expectOk(
      await sb.run(['doctor'], { env: { ...switched(), JOY_MEDIA_EDGE_URL: 'off' } }),
    );

    expect(r.out).toContain(`Data location: ${expectedDb()} (from JOY_MEDIA_HOME)`);
  });

  it('doctor reports --sqlite-path as the source when the flag is given', async () => {
    const flagDb = sb.path('flag-data', 'flag.sqlite3');
    const r = expectOk(
      await sb.run(['doctor', '--json', '--sqlite-path', flagDb], {
        env: { ...switched(), JOY_MEDIA_EDGE_URL: 'off' },
      }),
    );

    expect(r.json<{ dataLocation: unknown }>().dataLocation).toEqual({
      path: resolve(flagDb),
      source: '--sqlite-path',
    });
  });

  it('doctor without the switch reports the default location and its source', async () => {
    const r = expectOk(await sb.run(['doctor', '--json'], { env: { JOY_MEDIA_EDGE_URL: 'off' } }));

    expect(r.json<{ dataLocation: unknown }>().dataLocation).toEqual({
      path: defaultProjectDbPath(sb),
      source: process.platform === 'win32' ? 'APPDATA' : 'default',
    });
  });
});
