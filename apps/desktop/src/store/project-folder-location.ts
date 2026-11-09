import { win32 } from 'node:path';

/**
 * Where new project folders go by default (owner decision, 10 Nov 2026): `Documents\JOY Projects`.
 * A synced folder can corrupt `project.sqlite`, so when Documents sits under a OneDrive root the
 * profile folder is used instead. The rule uses Windows path semantics on every platform, so it
 * can be tested anywhere.
 */

export const DEFAULT_PROJECT_FOLDERS_NAME = 'JOY Projects';

export interface DefaultProjectFoldersInput {
  /** The Windows Documents folder, for example C:\Users\<name>\Documents. */
  readonly documentsDirectory: string;
  /** The user profile folder, for example C:\Users\<name>. Used when Documents is synced. */
  readonly userProfileDirectory: string;
  /** OneDrive sync roots, from the OneDrive, OneDriveConsumer and OneDriveCommercial variables. */
  readonly oneDriveRoots: readonly string[];
}

/**
 * Whether `path` is `root` or sits inside it. Windows paths compare without case, and a root only
 * matches whole path segments, so `OneDriveBackup` is not inside `OneDrive`.
 */
export function isInsideWindowsFolder(path: string, root: string): boolean {
  const relativePath = win32.relative(root.toLowerCase(), path.toLowerCase());
  if (relativePath === '') return true;
  return (
    !win32.isAbsolute(relativePath) &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${win32.sep}`)
  );
}

/** The folder that holds new project folders: `Documents\JOY Projects`, or the fallback. */
export function defaultProjectFoldersDirectory(input: DefaultProjectFoldersInput): string {
  const documentsAreSynced = input.oneDriveRoots.some(
    (root) => root.trim() !== '' && isInsideWindowsFolder(input.documentsDirectory, root),
  );
  const base = documentsAreSynced ? input.userProfileDirectory : input.documentsDirectory;
  return win32.join(base, DEFAULT_PROJECT_FOLDERS_NAME);
}
