import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isLocalPath, parseDriveTypes } from './local-path.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, lstatSync: vi.fn(actual.lstatSync as typeof lstatSync) };
});

describe('parseDriveTypes', () => {
  it('reads each drive type and ignores any other line', () => {
    const types = parseDriveTypes('C:=3\r\nz:=4\nnot a drive\n');

    expect(types.get('C:')).toBe(3);
    expect(types.get('Z:')).toBe(4);
    expect(types.size).toBe(2);
  });
});

describe('isLocalPath', () => {
  let root = '';

  beforeEach(() => {
    vi.clearAllMocks();
    root = mkdtempSync(join(tmpdir(), 'joy-local-path-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** The drive type table for the drive the temporary folder is on, as a fixed local drive. */
  function localDrives(): Map<string, number> {
    const drive = /^[A-Za-z]:/.exec(root)?.[0]?.toUpperCase();
    return new Map(drive === undefined ? [] : [[drive, 3]]);
  }

  it('refuses a UNC or device path, on any platform', () => {
    expect(isLocalPath('\\\\server\\share\\models', localDrives())).toBe(false);
    expect(isLocalPath('//server/share/models', localDrives())).toBe(false);
    expect(lstatSync).not.toHaveBeenCalled();
  });

  it('refuses a network drive and a drive the query did not classify', () => {
    const drives = new Map([['Z:', 4]]);

    expect(isLocalPath('Z:\\models', drives)).toBe(false);
    expect(isLocalPath('Q:\\models', drives)).toBe(false);
    expect(lstatSync).not.toHaveBeenCalled();
  });

  it('accepts a path on a local drive that is not linked, even when it does not exist yet', () => {
    expect(isLocalPath(join(root, 'models'), localDrives())).toBe(true);
    expect(isLocalPath(join(root, 'absent', 'models'), localDrives())).toBe(true);
  });

  it('refuses a path that passes through a junction', () => {
    const target = join(root, 'target');
    mkdirSync(target);
    const link = join(root, 'link');
    symlinkSync(target, link, 'junction');

    expect(isLocalPath(join(link, 'models'), localDrives())).toBe(false);
  });
});
