import { describe, expect, it } from 'vitest';
import {
  defaultProjectFoldersDirectory,
  isInsideWindowsFolder,
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
