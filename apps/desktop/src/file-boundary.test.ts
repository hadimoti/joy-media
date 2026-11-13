import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as fileBoundary from './file-boundary.js';

type ResolveDroppedPath = (
  value: string,
  source?: 'direct' | 'folder-entry',
) => Promise<{ readonly path: string; readonly kind: 'file' | 'directory' }>;

const resolveDroppedPath = (fileBoundary as unknown as { resolveDroppedPath?: ResolveDroppedPath })
  .resolveDroppedPath;

describe('resolveDroppedPath', () => {
  it('resolves a normal file path containing spaces and Unicode', async () => {
    expect(typeof resolveDroppedPath).toBe('function');
    const root = await mkdtemp(path.join(tmpdir(), 'joy drop path '));
    const file = path.join(root, 'موسیقی clip.mp4');
    try {
      await writeFile(file, 'media');
      const resolved = await resolveDroppedPath!(file);
      expect(resolved).toEqual({ path: await realpath(file), kind: 'file', size: 5 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  const windowsSpecific = process.platform === 'win32' ? it : it.skip;
  windowsSpecific.each([
    ['an alternate data stream', 'C:\\Media\\clip.mp4:stream'],
    ['an unnamed alternate data stream', 'C:\\Media\\clip.mp4::$DATA'],
    ['a trailing dot', 'C:\\Media\\clip.mp4.'],
    ['a trailing space', 'C:\\Media\\clip.mp4 '],
    ['a reserved device name', 'C:\\Media\\CON.mp4'],
  ])('Windows-only path check: rejects %s (requires Win32 path semantics)', (_label, value) => {
    expect(fileBoundary.isSafeLocalPathSyntax(value)).toBe(false);
  });

  it.each([
    ['a UNC path', '\\\\server\\share\\clip.mp4'],
    ['a device path', '\\\\.\\C:\\clip.mp4'],
    ['an extended device path', '\\\\?\\C:\\clip.mp4'],
    ['a reserved device name', 'C:\\Media\\CON.mp4'],
  ])('rejects %s before resolving the path', async (_label, value) => {
    expect(typeof resolveDroppedPath).toBe('function');
    await expect(resolveDroppedPath!(value)).rejects.toThrow();
  });

  it('follows a directly dropped file symlink only when it resolves to a regular file', async (context) => {
    const root = await mkdtemp(path.join(tmpdir(), 'joy drop symlink '));
    const target = path.join(root, 'target.mp4');
    const link = path.join(root, 'dropped-link.mp4');
    try {
      await writeFile(target, 'media');
      try {
        await symlink(target, link, 'file');
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? 'unknown error';
        context.skip(`file symlink creation is unavailable on this platform (${code})`);
        return;
      }
      expect(typeof resolveDroppedPath).toBe('function');
      await expect(resolveDroppedPath!(link)).resolves.toEqual({
        path: await realpath(target),
        kind: 'file',
      });
      await expect(resolveDroppedPath!(link, 'folder-entry')).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not follow a dropped folder junction into another folder tree', async (context) => {
    const root = await mkdtemp(path.join(tmpdir(), 'joy drop junction '));
    const folder = path.join(root, 'folder');
    const junction = path.join(root, 'folder-junction');
    try {
      await mkdir(folder);
      try {
        await symlink(folder, junction, 'junction');
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? 'unknown error';
        context.skip(`directory junction creation is unavailable on this platform (${code})`);
        return;
      }
      await expect(resolveDroppedPath!(junction)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
