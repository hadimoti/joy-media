import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveDesktopPaths } from './paths.js';

describe('resolveDesktopPaths', () => {
  it('derives the database file and media root under the given userData directory', () => {
    // Build expectations with the platform's own separator: the desktop app
    // ships on Windows, but this suite also runs on the Linux CI runner.
    const userDataDir = join('C:', 'Users', 'alice', 'AppData', 'Roaming', 'joy-media');
    const paths = resolveDesktopPaths(userDataDir);
    expect(paths.databaseFile).toBe(join(userDataDir, 'joy-media.sqlite3'));
    expect(paths.mediaRoot).toBe(join(userDataDir, 'media'));
    expect(paths.userDataDir).toBe(userDataDir);
    expect(paths.databaseFile.startsWith(userDataDir)).toBe(true);
    expect(paths.mediaRoot.startsWith(userDataDir)).toBe(true);
  });
});
