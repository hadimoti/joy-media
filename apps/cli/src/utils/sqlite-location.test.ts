import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeProjectDatabase, resolveDefaultSqliteLocation } from './sqlite-location.js';

const DEFAULT_HOME = join('C:', 'Users', 'alice', '.joy-media');
const APPDATA = join('C:', 'Users', 'alice', 'AppData', 'Roaming');
const JOY_HOME = join('D:', 'joy-data');
const DB = 'joy-media.sqlite3';

describe('resolveDefaultSqliteLocation', () => {
  it('puts the database under <JOY_MEDIA_HOME>/desktop when the variable is set', () => {
    const location = resolveDefaultSqliteLocation({
      env: { JOY_MEDIA_HOME: JOY_HOME, APPDATA },
      platform: 'win32',
      defaultHome: DEFAULT_HOME,
    });

    expect(location).toEqual({ path: join(JOY_HOME, 'desktop', DB), source: 'JOY_MEDIA_HOME' });
  });

  it('resolves a relative JOY_MEDIA_HOME against the working directory', () => {
    const location = resolveDefaultSqliteLocation({
      env: { JOY_MEDIA_HOME: '  relative-home  ' },
      platform: 'win32',
      defaultHome: DEFAULT_HOME,
    });

    expect(location.path).toBe(join(resolve('relative-home'), 'desktop', DB));
    expect(location.source).toBe('JOY_MEDIA_HOME');
  });

  it('ignores an empty or blank JOY_MEDIA_HOME and keeps the APPDATA default on Windows', () => {
    for (const blank of ['', '   ']) {
      const location = resolveDefaultSqliteLocation({
        env: { JOY_MEDIA_HOME: blank, APPDATA },
        platform: 'win32',
        defaultHome: DEFAULT_HOME,
      });

      expect(location).toEqual({
        path: join(APPDATA, '@joy-media', 'desktop', DB),
        source: 'APPDATA',
      });
    }
  });

  it('keeps the home-folder default when JOY_MEDIA_HOME is blank and APPDATA is missing', () => {
    const location = resolveDefaultSqliteLocation({
      env: { JOY_MEDIA_HOME: ' ' },
      platform: 'win32',
      defaultHome: DEFAULT_HOME,
    });

    expect(location).toEqual({ path: join(DEFAULT_HOME, DB), source: 'default' });
  });

  it('uses the home folder off Windows when JOY_MEDIA_HOME is unset, even if APPDATA is set', () => {
    const location = resolveDefaultSqliteLocation({
      env: { APPDATA },
      platform: 'linux',
      defaultHome: DEFAULT_HOME,
    });

    expect(location).toEqual({ path: join(DEFAULT_HOME, DB), source: 'default' });
  });

  it('moves a POSIX default under JOY_MEDIA_HOME/desktop as well', () => {
    const location = resolveDefaultSqliteLocation({
      env: { JOY_MEDIA_HOME: JOY_HOME },
      platform: 'linux',
      defaultHome: DEFAULT_HOME,
    });

    expect(location.path).toBe(join(resolve(JOY_HOME), 'desktop', DB));
  });
});

describe('describeProjectDatabase', () => {
  const base = { env: {}, platform: 'win32' as const, defaultHome: DEFAULT_HOME };

  it('gives --sqlite-path precedence over JOY_MEDIA_HOME and JOY_MEDIA_SQLITE_PATH', () => {
    const flagPath = join('E:', 'scratch', 'flag.sqlite3');
    const location = describeProjectDatabase({
      ...base,
      flagPath,
      env: { JOY_MEDIA_HOME: JOY_HOME, JOY_MEDIA_SQLITE_PATH: join('F:', 'env.sqlite3') },
    });

    expect(location).toEqual({ path: resolve(flagPath), source: '--sqlite-path' });
  });

  it('names JOY_MEDIA_SQLITE_PATH when it is the only override', () => {
    const envPath = join('F:', 'env.sqlite3');
    const location = describeProjectDatabase({
      ...base,
      env: { JOY_MEDIA_HOME: JOY_HOME, JOY_MEDIA_SQLITE_PATH: envPath },
    });

    expect(location).toEqual({ path: envPath, source: 'JOY_MEDIA_SQLITE_PATH' });
  });

  it('names JOY_MEDIA_HOME when the variable selects the folder', () => {
    const location = describeProjectDatabase({ ...base, env: { JOY_MEDIA_HOME: JOY_HOME } });

    expect(location).toEqual({
      path: join(resolve(JOY_HOME), 'desktop', DB),
      source: 'JOY_MEDIA_HOME',
    });
  });

  it('names the default when no override is set', () => {
    const location = describeProjectDatabase({ ...base, env: { APPDATA } });

    expect(location).toEqual({
      path: join(APPDATA, '@joy-media', 'desktop', DB),
      source: 'APPDATA',
    });
  });
});
