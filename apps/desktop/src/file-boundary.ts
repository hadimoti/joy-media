import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export type DerivativeKind = 'thumbnail' | 'proxy';
export interface OpaqueFileRef {
  readonly kind: 'local-file';
  readonly id: string;
  readonly displayName: string;
}
export interface FileBoundary {
  registerSelection(path: string, displayName?: string): OpaqueFileRef;
  revoke(ref: OpaqueFileRef): void;
  requestDerivative(
    ref: OpaqueFileRef,
    kind: DerivativeKind,
  ): { refId: string; kind: DerivativeKind };
}

export type DroppedPathSource = 'direct' | 'folder-entry' | 'registered';

export interface ResolvedDroppedPath {
  readonly path: string;
  readonly kind: 'file' | 'directory';
  readonly size: number;
}

/**
 * Validates a dropped path and returns its real path before the importer stats,
 * lists, hashes, or reads it. A directory is accepted only as the directly
 * dropped root; its children must each resolve to regular files.
 */
export async function resolveDroppedPath(
  value: string,
  source: DroppedPathSource = 'direct',
): Promise<ResolvedDroppedPath> {
  if (!isSafeLocalPathSyntax(value)) throw new Error('Dropped path is not a supported local path');

  const absolutePath = path.resolve(value);
  const root = path.parse(absolutePath).root;
  const relativePath = path.relative(root, absolutePath);
  const components = relativePath.split(path.sep).filter(Boolean);
  let currentPath = root;
  let finalComponentIsSymlink = false;
  for (const [index, component] of components.entries()) {
    currentPath = path.join(currentPath, component);
    const entry = await lstat(currentPath);
    const isFinalComponent = index === components.length - 1;
    if (entry.isSymbolicLink()) {
      // Follow a symlink only when the user dropped that symlink as a file and its target is a regular file; never follow into a different folder tree for folder drops.
      if (source !== 'direct' || !isFinalComponent) {
        throw new Error('Dropped path crosses a symlink or junction');
      }
      finalComponentIsSymlink = true;
    }
  }

  const resolvedPath = await realpath(absolutePath);
  const resolvedInfo = await stat(resolvedPath);
  const kind = resolvedInfo.isFile()
    ? 'file'
    : resolvedInfo.isDirectory()
      ? 'directory'
      : undefined;
  if (kind === undefined || (source === 'folder-entry' && kind !== 'file')) {
    throw new Error('Dropped path must resolve to a regular file or folder');
  }
  if (finalComponentIsSymlink && kind !== 'file') {
    throw new Error('A dropped folder cannot be a symlink or junction');
  }
  return { path: resolvedPath, kind, size: resolvedInfo.size };
}

/** Syntax-only guard shared with the synchronous opaque-reference registry. */
export function isSafeLocalPathSyntax(value: string): boolean {
  if (value.length === 0 || value.length > 32_768 || value.includes('\0')) return false;
  if (/^(?:\\\\[.?]\\|\\\\[^\\]+\\[^\\]+)/.test(value) || value.startsWith('//')) {
    return false;
  }
  if (process.platform === 'win32') {
    if (!/^[A-Za-z]:[\\/]/.test(value)) return false;
    const components = value.replaceAll('/', '\\').split('\\').filter(Boolean).slice(1);
    return !components.some((component) => {
      if (component.includes(':') || component.endsWith('.') || component.endsWith(' ')) {
        return true;
      }
      const normalized = component.replace(/[ .]+$/g, '');
      const stem = normalized.split('.')[0] ?? '';
      return /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])$/i.test(stem);
    });
  }
  return path.isAbsolute(value);
}

export function createFileBoundary(
  tokenFactory: () => string = () => crypto.randomUUID(),
): FileBoundary {
  const approved = new Set<string>();
  return {
    registerSelection(path, displayName = basename(path)) {
      if (!isSafeLocalPathSyntax(path)) throw new Error('Selection must be an absolute local path');
      const id = tokenFactory();
      approved.add(id);
      return { kind: 'local-file', id, displayName: basename(displayName).slice(0, 255) };
    },
    revoke(ref) {
      approved.delete(ref.id);
    },
    requestDerivative(ref, kind) {
      if (ref.kind !== 'local-file' || !approved.has(ref.id))
        throw new Error('Unknown or revoked local file reference');
      return { refId: ref.id, kind };
    },
  };
}
function basename(value: string): string {
  return value.split(/[\\/]/).pop() || 'selected-file';
}
