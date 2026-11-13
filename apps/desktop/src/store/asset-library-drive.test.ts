import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyLibraryDrive, driveRootOf, isNetworkPath } from './asset-library-drive.js';

describe('asset library drive', () => {
  it('knows a network share from the path itself', () => {
    expect(isNetworkPath('\\\\server\\share\\media')).toBe(true);
    expect(classifyLibraryDrive('\\\\server\\share\\media')).toBe('network');
  });

  it('asks the probe what a local drive is', () => {
    const directory = path.resolve('media');
    const root = driveRootOf(directory);

    expect(
      classifyLibraryDrive(directory, (probeRoot) => (probeRoot === root ? 'removable' : 'fixed')),
    ).toBe('removable');
  });

  it('is "unknown" when nothing can tell it, so nobody is warned about nothing', () => {
    expect(classifyLibraryDrive(path.resolve('media'))).toBe('unknown');
    expect(classifyLibraryDrive('media/clips')).toBe('unknown');
  });

  it('knows the drive root of a path', () => {
    expect(driveRootOf('/media/clips')).toBe('/');
    expect(driveRootOf('media/clips')).toBeUndefined();
  });
});
