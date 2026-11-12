import { describe, expect, it } from 'vitest';
import {
  defaultProjectFoldersDirectory,
  DEV_PROJECT_FOLDERS_ENV,
  isInsideWindowsFolder,
  projectFoldersDirectory,
} from './project-folder-location.js';

const PROFILE = 'C:\\Users\\Hadi';
const DOCUMENTS = 'C:\\Users\\Hadi\\Documents';

describe('isInsideWindowsFolder', () => {
  it('matches the folder itself and its contents, ignoring case', () => {
    expect(isInsideWindowsFolder('c:\\users\\hadi\\onedrive', 'C:\\Users\\Hadi\\OneDrive')).toBe(
      true,
    );
    expect(
      isInsideWindowsFolder('c:\\users\\hadi\\onedrive\\Documents', 'C:\\Users\\Hadi\\OneDrive'),
    ).toBe(true);
  });

  it('does not match a folder that only shares the start of the name', () => {
    expect(
      isInsideWindowsFolder(
        'C:\\Users\\Hadi\\OneDriveBackup\\Documents',
        'C:\\Users\\Hadi\\OneDrive',
      ),
    ).toBe(false);
  });

  it('does not match another drive', () => {
    expect(isInsideWindowsFolder('D:\\Documents', 'C:\\Users\\Hadi\\OneDrive')).toBe(false);
  });

  it('treats a name that starts with two dots as an ordinary folder inside the root', () => {
    expect(
      isInsideWindowsFolder('C:\\Users\\Hadi\\OneDrive\\..notes', 'C:\\Users\\Hadi\\OneDrive'),
    ).toBe(true);
  });
});

describe('defaultProjectFoldersDirectory', () => {
  it('uses Documents\\JOY Projects when Documents is not synced', () => {
    expect(
      defaultProjectFoldersDirectory({
        documentsDirectory: DOCUMENTS,
        userProfileDirectory: PROFILE,
        oneDriveRoots: [],
      }),
    ).toBe('C:\\Users\\Hadi\\Documents\\JOY Projects');
  });

  it('falls back to the profile folder when Documents sits under OneDrive', () => {
    expect(
      defaultProjectFoldersDirectory({
        documentsDirectory: 'C:\\Users\\Hadi\\OneDrive\\Documents',
        userProfileDirectory: PROFILE,
        oneDriveRoots: ['C:\\Users\\Hadi\\OneDrive'],
      }),
    ).toBe('C:\\Users\\Hadi\\JOY Projects');
  });

  it('checks every OneDrive root, including a business one with a space in its name', () => {
    expect(
      defaultProjectFoldersDirectory({
        documentsDirectory: 'C:\\Users\\Hadi\\OneDrive - Contoso\\Documents',
        userProfileDirectory: PROFILE,
        oneDriveRoots: ['C:\\Users\\Hadi\\OneDrive', 'C:\\Users\\Hadi\\OneDrive - Contoso'],
      }),
    ).toBe('C:\\Users\\Hadi\\JOY Projects');
  });

  it('ignores blank OneDrive values', () => {
    expect(
      defaultProjectFoldersDirectory({
        documentsDirectory: DOCUMENTS,
        userProfileDirectory: PROFILE,
        oneDriveRoots: ['', '   '],
      }),
    ).toBe('C:\\Users\\Hadi\\Documents\\JOY Projects');
  });

  it('does not treat a lookalike folder as the OneDrive root', () => {
    expect(
      defaultProjectFoldersDirectory({
        documentsDirectory: 'C:\\Users\\Hadi\\OneDriveBackup\\Documents',
        userProfileDirectory: PROFILE,
        oneDriveRoots: ['C:\\Users\\Hadi\\OneDrive'],
      }),
    ).toBe('C:\\Users\\Hadi\\OneDriveBackup\\Documents\\JOY Projects');
  });
});

describe('projectFoldersDirectory', () => {
  const defaults = {
    documentsDirectory: DOCUMENTS,
    userProfileDirectory: PROFILE,
    oneDriveRoots: [],
  };
  const SCRATCH = 'C:\\jgp\\bot-lane-b\\projects';

  /** An environment that fails the test if anything reads it. */
  const unreadable = new Proxy({} as Record<string, string | undefined>, {
    get: () => {
      throw new Error('the environment was read');
    },
    has: () => {
      throw new Error('the environment was read');
    },
    ownKeys: () => {
      throw new Error('the environment was read');
    },
  });

  it('a packaged app never reads the environment and keeps the real default', () => {
    expect(
      projectFoldersDirectory({ ...defaults, isPackaged: true, environment: unreadable }),
    ).toBe('C:\\Users\\Hadi\\Documents\\JOY Projects');
  });

  it('a packaged app ignores the development folder even when it is set', () => {
    expect(
      projectFoldersDirectory({
        ...defaults,
        isPackaged: true,
        environment: { [DEV_PROJECT_FOLDERS_ENV]: SCRATCH },
      }),
    ).toBe(defaultProjectFoldersDirectory(defaults));
    expect(
      projectFoldersDirectory({
        documentsDirectory: 'C:\\Users\\Hadi\\OneDrive\\Documents',
        userProfileDirectory: PROFILE,
        oneDriveRoots: ['C:\\Users\\Hadi\\OneDrive'],
        isPackaged: true,
        environment: { [DEV_PROJECT_FOLDERS_ENV]: SCRATCH },
      }),
    ).toBe('C:\\Users\\Hadi\\JOY Projects');
  });

  it('an unpacked run uses the development folder when it is set', () => {
    expect(
      projectFoldersDirectory({
        ...defaults,
        isPackaged: false,
        environment: { [DEV_PROJECT_FOLDERS_ENV]: ` ${SCRATCH} ` },
      }),
    ).toBe(SCRATCH);
  });

  it('an unpacked run with nothing set uses the default', () => {
    expect(projectFoldersDirectory({ ...defaults, isPackaged: false, environment: {} })).toBe(
      defaultProjectFoldersDirectory(defaults),
    );
    expect(
      projectFoldersDirectory({
        ...defaults,
        isPackaged: false,
        environment: { [DEV_PROJECT_FOLDERS_ENV]: '  ' },
      }),
    ).toBe(defaultProjectFoldersDirectory(defaults));
  });

  it('a development folder that is not an absolute path stops the start instead of falling back', () => {
    expect(() =>
      projectFoldersDirectory({
        ...defaults,
        isPackaged: false,
        environment: { [DEV_PROJECT_FOLDERS_ENV]: 'projects' },
      }),
    ).toThrow(/absolute Windows path/);
  });
});
