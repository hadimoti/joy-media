/**
 * The kind of drive the asset library sits on (T-P08).
 *
 * A library on a removable drive or a network share comes and goes: unplug it
 * and the media is missing. The dialog says so, calmly, when it can tell.
 *
 * The decision is kept separate from the way the operating system is asked, so
 * the rule can be tested without a disk, and so an unknown answer never turns
 * into a warning the owner did not need.
 */
import path from 'node:path';

export type AssetLibraryDriveType = 'fixed' | 'removable' | 'network' | 'unknown';

/**
 * The root of the drive a path sits on — "E:\\" on Windows, "/" elsewhere.
 * Undefined when the path names no drive at all.
 */
export function driveRootOf(directory: string): string | undefined {
  const root = path.parse(directory).root;
  return root.length > 0 ? root : undefined;
}

/** Is this path a network share, like "\\server\share\media"? */
export function isNetworkPath(directory: string): boolean {
  return /^[\\/]{2}/.test(directory);
}

/**
 * The kind of drive a directory lives on. A network share is decided from the
 * path itself; anything else is left to the probe, which asks the operating
 * system. No probe means "unknown", and no warning.
 */
export function classifyLibraryDrive(
  directory: string,
  probe?: (root: string) => AssetLibraryDriveType | undefined,
): AssetLibraryDriveType {
  if (isNetworkPath(directory)) return 'network';
  const root = driveRootOf(directory);
  if (root === undefined) return 'unknown';
  return probe?.(root) ?? 'unknown';
}
