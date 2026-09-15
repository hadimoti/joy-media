import { describe, expect, it } from 'vitest';
import { resolveDesktopPaths } from './paths.js';

describe('resolveDesktopPaths', () => {
  it('derives the database file and media root under the given userData directory', () => {
    const paths = resolveDesktopPaths('C:\\Users\\alice\\AppData\\Roaming\\joy-media');
    expect(paths.databaseFile).toBe(
      'C:\\Users\\alice\\AppData\\Roaming\\joy-media\\joy-media.sqlite3',
    );
    expect(paths.mediaRoot).toBe('C:\\Users\\alice\\AppData\\Roaming\\joy-media\\media');
    expect(paths.userDataDir).toBe('C:\\Users\\alice\\AppData\\Roaming\\joy-media');
  });
});
