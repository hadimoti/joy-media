import { closeSync, existsSync, openSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';

function isInside(baseDir: string, candidate: string): boolean {
  const relativePath = path.relative(baseDir, candidate);
  const leavesBase = relativePath === '..' || relativePath.startsWith(`..${path.sep}`);
  return !leavesBase && !path.isAbsolute(relativePath);
}

/** Resolves a library-relative file while keeping lexical and symlink paths inside the library. */
export function resolveLibraryAssetPath(baseDir: string, relativePath: string): string | undefined {
  if (
    relativePath.length === 0 ||
    path.isAbsolute(relativePath) ||
    /^[A-Za-z]:/.test(relativePath) ||
    relativePath.startsWith('/') ||
    relativePath.startsWith('\\')
  ) {
    return undefined;
  }

  const normalizedBase = path.resolve(baseDir);
  const candidate = path.resolve(normalizedBase, relativePath);
  if (!isInside(normalizedBase, candidate)) return undefined;

  if (existsSync(candidate)) {
    try {
      const realBase = realpathSync(normalizedBase);
      const realCandidate = realpathSync(candidate);
      if (!isInside(realBase, realCandidate)) return undefined;
    } catch {
      return undefined;
    }
  }

  return candidate;
}

/** Reads up to `length` bytes from the start of a file; an unreadable file gives an empty array. */
export function readFileHead(filePath: string, length: number): Uint8Array {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(filePath, 'r');
    const buffer = new Uint8Array(length);
    const read = readSync(descriptor, buffer, 0, length, 0);
    return buffer.subarray(0, read);
  } catch {
    return new Uint8Array(0);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
