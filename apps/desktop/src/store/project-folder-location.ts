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

/**
 * Development only: `JOY_PROJECTS_DIR` names another folder for folder projects, so a test run of an unpacked copy never
 * touches the real `Documents\JOY Projects`. A packaged (installed) app never reads it. The value must be an absolute
 * Windows path; anything else stops the start, so a typo can not fall back to the real folder.
 */
export const DEV_PROJECT_FOLDERS_ENV = 'JOY_PROJECTS_DIR';

export interface ProjectFoldersDirectoryInput {
  /** `app.isPackaged`. When true, the environment is not read at all. */
  readonly isPackaged: boolean;
  /** The process environment; read only when the app is not packaged. */
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** `app.getPath('documents')`, which can throw. Not called when the development folder is set. */
  readonly documentsDirectory: () => string;
  /** `app.getPath('home')`, which can throw. Not called when the development folder is set. */
  readonly userProfileDirectory: () => string;
  /** `os.homedir()`: the fallback when Electron gives no path (Documents becomes `<home>\Documents`). */
  readonly homeDirectory: () => string;
  /** OneDrive sync roots, from the OneDrive, OneDriveConsumer and OneDriveCommercial variables. */
  readonly oneDriveRoots: readonly string[];
}

/** A path from Electron, or the fallback when Electron throws or gives an empty path. */
function pathOr(read: () => string, fallback: () => string): string {
  try {
    const value = read();
    if (value.trim() !== '') return value;
  } catch {
    // Electron throws "Failed to get '<name>' path" when Windows has no such folder for this user.
  }
  return fallback();
}

/** The folder for folder projects: the development folder of an unpacked run, if set, or the default. */
export function projectFoldersDirectory(input: ProjectFoldersDirectoryInput): string {
  if (!input.isPackaged) {
    const override = input.environment[DEV_PROJECT_FOLDERS_ENV];
    if (override !== undefined && override.trim() !== '') {
      const trimmed = override.trim();
      if (!/^[A-Za-z]:[\\/]/.test(trimmed) && !trimmed.startsWith('\\\\')) {
        throw new Error(`${DEV_PROJECT_FOLDERS_ENV} must be an absolute Windows path.`);
      }
      return win32.normalize(trimmed);
    }
  }
  return defaultProjectFoldersDirectory({
    documentsDirectory: pathOr(input.documentsDirectory, () =>
      win32.join(input.homeDirectory(), 'Documents'),
    ),
    userProfileDirectory: pathOr(input.userProfileDirectory, input.homeDirectory),
    oneDriveRoots: input.oneDriveRoots,
  });
}
