import { join } from 'node:path';

export interface DesktopPaths {
  readonly userDataDir: string;
  /** The single local SQLite file backing both the project store and this runtime database. */
  readonly databaseFile: string;
  /** Root directory for locally ingested media and generated derivatives (thumbnails/proxies). */
  readonly mediaRoot: string;
}

/**
 * Pure so it is testable without Electron's `app.getPath('userData')`. The caller (main
 * process) passes that value in; nothing here reaches into Electron itself.
 */
export function resolveDesktopPaths(userDataDir: string): DesktopPaths {
  return {
    userDataDir,
    databaseFile: join(userDataDir, 'joy-media.sqlite3'),
    mediaRoot: join(userDataDir, 'media'),
  };
}
