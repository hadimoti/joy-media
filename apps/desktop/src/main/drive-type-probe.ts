/**
 * Asks Windows what kind of drive a folder sits on (T-P08).
 *
 * Windows answers with a number: 2 is a removable drive, 3 a fixed one and 4 a
 * network share. The answer is cached per drive, so the settings dialog asks
 * once. When the question cannot be answered the drive is "unknown", and the
 * owner is not warned about a drive we know nothing about.
 */
import { execFile } from 'node:child_process';
import {
  driveRootOf,
  isNetworkPath,
  type AssetLibraryDriveType,
} from '../store/asset-library-drive.js';

const DRIVE_TYPES: Readonly<Record<number, AssetLibraryDriveType>> = {
  2: 'removable',
  3: 'fixed',
  4: 'network',
};

const cached = new Map<string, AssetLibraryDriveType>();

/** "E:\\" is the drive "E:" as Windows names it. */
function deviceIdOf(root: string): string {
  return root.replace(/[\\/]+$/, '');
}

function queryWindowsDriveType(deviceId: string): Promise<AssetLibraryDriveType> {
  const command = `(Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DeviceID='${deviceId}'").DriveType`;
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { timeout: 5000, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve('unknown');
          return;
        }
        const value = Number(String(stdout).trim());
        resolve(DRIVE_TYPES[value] ?? 'unknown');
      },
    );
  });
}

/** The kind of drive this root is. Cached per drive, so opening the settings
 * again is free. */
export async function driveTypeOfRoot(root: string): Promise<AssetLibraryDriveType> {
  const known = cached.get(root);
  if (known !== undefined) return known;
  let type: AssetLibraryDriveType;
  if (process.platform !== 'win32') {
    // No removable drives and no network shares to tell apart from here.
    type = 'fixed';
  } else {
    type = await queryWindowsDriveType(deviceIdOf(root));
  }
  cached.set(root, type);
  return type;
}

/**
 * The kind of drive a folder sits on: a network share is read from the path,
 * and anything else is asked of Windows.
 */
export async function classifyDriveOfDirectory(directory: string): Promise<AssetLibraryDriveType> {
  if (isNetworkPath(directory)) return 'network';
  const root = driveRootOf(directory);
  if (root === undefined) return 'unknown';
  return driveTypeOfRoot(root);
}
