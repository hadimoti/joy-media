import { lstatSync } from 'node:fs';
import { join, parse, resolve } from 'node:path';

/**
 * DriveInfo.DriveType values that stay on this machine: 2 removable, 3 fixed, 5 optical, 6 RAM disk.
 * A network drive (4) reaches another machine, and an unknown type is treated as network.
 */
const LOCAL_DRIVE_TYPES: ReadonlySet<number> = new Set([2, 3, 5, 6]);

/** Reads the "C:=3" lines of the doctor's drive query. Any other line is ignored. */
export function parseDriveTypes(output: string): Map<string, number> {
  const types = new Map<string, number>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^([A-Za-z]:)=(\d+)$/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) {
      types.set(match[1].toUpperCase(), Number(match[2]));
    }
  }
  return types;
}

/**
 * Whether reading a path stays on this machine. A UNC or device path is refused, and so is a path on
 * a network drive or on a drive the query did not classify. A path is refused too when a component is
 * a symbolic link or junction, because its target could be remote. Only link metadata is read, and
 * only after the drive is known to be local.
 */
export function isLocalPath(path: string, driveTypes: ReadonlyMap<string, number>): boolean {
  if (/^[\\/]{2}/.test(path)) return false;
  const drive = /^([A-Za-z]:)/.exec(path)?.[1]?.toUpperCase();
  if (drive !== undefined) {
    const type = driveTypes.get(drive);
    if (type === undefined || !LOCAL_DRIVE_TYPES.has(type)) return false;
  }
  const absolute = resolve(path);
  if (/^[\\/]{2}/.test(absolute)) return false;
  return !hasLinkedComponent(absolute);
}

function hasLinkedComponent(absolute: string): boolean {
  const { root } = parse(absolute);
  let current = root;
  for (const part of absolute.slice(root.length).split(/[\\/]/)) {
    if (part === '') continue;
    current = join(current, part);
    try {
      if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink() === true) return true;
    } catch {
      return true;
    }
  }
  return false;
}
