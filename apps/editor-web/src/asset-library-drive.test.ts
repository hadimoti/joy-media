import { describe, expect, it } from 'vitest';
import {
  INTERMITTENT_DRIVE_WARNING,
  isIntermittentAssetLibraryDrive,
} from './asset-library-drive.js';

describe('asset library drive warning', () => {
  it('warns about a drive that is not always there', () => {
    expect(isIntermittentAssetLibraryDrive('removable')).toBe(true);
    expect(isIntermittentAssetLibraryDrive('network')).toBe(true);
  });

  it('stays quiet about a fixed drive, and about a drive it could not identify', () => {
    expect(isIntermittentAssetLibraryDrive('fixed')).toBe(false);
    expect(isIntermittentAssetLibraryDrive('unknown')).toBe(false);
    expect(isIntermittentAssetLibraryDrive(undefined)).toBe(false);
  });

  it('says the same calm thing every time', () => {
    expect(INTERMITTENT_DRIVE_WARNING).toBe(
      'This drive is not always connected. Your media will show as missing when it is unplugged.',
    );
  });
});
