import { join, resolve } from 'node:path';

/** The project database file name. The desktop app and the CLI use the same file name. */
export const DATABASE_FILE_NAME = 'joy-media.sqlite3';

/** Where the default database comes from, when no flag or environment override names a file. */
export type DefaultSqliteSource = 'JOY_MEDIA_HOME' | 'APPDATA' | 'default';

/** Every source a reader can be told about, including the explicit overrides. */
export type DataLocationSource = '--sqlite-path' | 'JOY_MEDIA_SQLITE_PATH' | DefaultSqliteSource;

export interface DataLocation {
  readonly path: string;
  readonly source: DataLocationSource;
}

/**
 * The default project database for an environment. Pure: it reads no file and creates no folder, so
 * `doctor` can call it on the default path. Order: a non-empty `JOY_MEDIA_HOME` moves everything to
 * `<JOY_MEDIA_HOME>/desktop`; otherwise APPDATA on Windows; otherwise the default home folder.
 */
export function resolveDefaultSqliteLocation(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  /** The home folder used when neither JOY_MEDIA_HOME nor APPDATA applies (`~/.joy-media`). */
  readonly defaultHome: string;
}): DataLocation {
  const configuredHome = input.env.JOY_MEDIA_HOME?.trim();
  if (configuredHome) {
    return {
      path: join(resolve(configuredHome), 'desktop', DATABASE_FILE_NAME),
      source: 'JOY_MEDIA_HOME',
    };
  }
  if (input.platform === 'win32' && input.env.APPDATA) {
    return {
      path: join(input.env.APPDATA, '@joy-media', 'desktop', DATABASE_FILE_NAME),
      source: 'APPDATA',
    };
  }
  return { path: join(input.defaultHome, DATABASE_FILE_NAME), source: 'default' };
}

/**
 * The database a command would use, named with where it came from. The `--sqlite-path` flag wins over
 * every environment setting. The `cli-config.json` key is not read here, because `doctor` reads no file.
 */
export function describeProjectDatabase(input: {
  readonly flagPath?: string | undefined;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly defaultHome: string;
}): DataLocation {
  if (input.flagPath) return { path: resolve(input.flagPath), source: '--sqlite-path' };
  const overridePath = input.env.JOY_MEDIA_SQLITE_PATH;
  if (overridePath) return { path: overridePath, source: 'JOY_MEDIA_SQLITE_PATH' };
  return resolveDefaultSqliteLocation(input);
}
