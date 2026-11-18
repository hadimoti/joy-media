// @vitest-environment node
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readFileHead, resolveLibraryAssetPath } from './library-asset-path.js';

function makeDirectories(): { root: string; baseDir: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'joy-library-path-'));
  const baseDir = path.join(root, 'library');
  mkdirSync(baseDir);
  return { root, baseDir };
}

function isPermissionError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EPERM';
}

const symlinkProbe = mkdtempSync(path.join(tmpdir(), 'joy-library-path-symlink-probe-'));
let symlinkSupported = true;
try {
  const target = path.join(symlinkProbe, 'target');
  writeFileSync(target, 'target');
  symlinkSync(target, path.join(symlinkProbe, 'link'), 'file');
} catch (error) {
  if (isPermissionError(error)) symlinkSupported = false;
  else throw error;
} finally {
  rmSync(symlinkProbe, { recursive: true, force: true });
}

describe('resolveLibraryAssetPath', () => {
  it('returns a normal file path inside the library', () => {
    const { root, baseDir } = makeDirectories();
    try {
      const file = path.join(baseDir, 'images', 'cover.png');
      mkdirSync(path.dirname(file));
      writeFileSync(file, 'image');

      expect(resolveLibraryAssetPath(baseDir, path.join('images', 'cover.png'))).toBe(
        path.normalize(file),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== 'win32')('rejects Windows traversal path ..\\x', () => {
    const { root, baseDir } = makeDirectories();
    try {
      expect(resolveLibraryAssetPath(baseDir, '..\\x')).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['../x', 'a/../../x'])(
    'rejects POSIX traversal path %s on every platform',
    (relativePath) => {
      const { root, baseDir } = makeDirectories();
      try {
        expect(resolveLibraryAssetPath(baseDir, relativePath)).toBeUndefined();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'rejects a Windows sibling folder that shares the library name prefix',
    () => {
      const { root, baseDir } = makeDirectories();
      try {
        expect(resolveLibraryAssetPath(baseDir, '..\\library2\\a')).toBeUndefined();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('rejects a POSIX sibling folder that shares the library name prefix', () => {
    const { root, baseDir } = makeDirectories();
    try {
      expect(resolveLibraryAssetPath(baseDir, '../library2/a')).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects absolute paths', () => {
    const { root, baseDir } = makeDirectories();
    try {
      expect(resolveLibraryAssetPath(baseDir, path.resolve(root, 'outside.png'))).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['POSIX', path.posix.resolve('/', 'outside.png')],
    ['Windows', path.win32.resolve('C:\\', 'outside.png')],
  ])('rejects %s absolute path syntax', (_style, absolutePath) => {
    const { root, baseDir } = makeDirectories();
    try {
      expect(resolveLibraryAssetPath(baseDir, absolutePath)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('treats encoded-looking input as a literal filename without decoding it', () => {
    const { root, baseDir } = makeDirectories();
    try {
      const relativePath = '%2e%2e%2foutside.png';
      const file = path.join(baseDir, relativePath);
      writeFileSync(file, 'literal');

      expect(resolveLibraryAssetPath(baseDir, relativePath)).toBe(path.normalize(file));
      expect(existsSync(realpathSync(file))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(!symlinkSupported)('rejects a symlink that escapes the library', () => {
    const { root, baseDir } = makeDirectories();
    try {
      const outside = path.join(root, 'outside.png');
      const link = path.join(baseDir, 'escape.png');
      writeFileSync(outside, 'outside');
      symlinkSync(outside, link, 'file');

      expect(resolveLibraryAssetPath(baseDir, 'escape.png')).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a folder junction that points outside the library (needs no admin rights)', () => {
    const { root, baseDir } = makeDirectories();
    try {
      const outsideDir = path.join(root, 'outside-dir');
      mkdirSync(outsideDir);
      writeFileSync(path.join(outsideDir, 'secret.png'), 'outside');
      symlinkSync(outsideDir, path.join(baseDir, 'escape-dir'), 'junction');

      expect(resolveLibraryAssetPath(baseDir, 'escape-dir/secret.png')).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('readFileHead', () => {
  it('reads the first bytes, fewer when the file is short, and nothing for a missing file', () => {
    const { root, baseDir } = makeDirectories();
    try {
      const file = path.join(baseDir, 'clip');
      writeFileSync(file, Buffer.from([1, 2, 3, 4, 5]));

      expect([...readFileHead(file, 3)]).toEqual([1, 2, 3]);
      expect([...readFileHead(file, 32)]).toEqual([1, 2, 3, 4, 5]);
      expect(readFileHead(path.join(baseDir, 'missing'), 32)).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
