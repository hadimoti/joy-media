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
const DRIVE_ROOT_PATTERN = /^[A-Za-z]:\\?$/;

interface DriveTypeProbeRuntime {
  readonly platform?: NodeJS.Platform;
  readonly execFile?: typeof execFile;
}

function queryWindowsDriveType(
  deviceId: string,
  runExecFile: typeof execFile,
): Promise<AssetLibraryDriveType> {
  const command = `(Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DeviceID='${deviceId}'").DriveType`;
  return new Promise((resolve) => {
    runExecFile(
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
export async function driveTypeOfRoot(
  root: string,
  runtime: DriveTypeProbeRuntime = {},
): Promise<AssetLibraryDriveType> {
  if (typeof root !== 'string' || !DRIVE_ROOT_PATTERN.test(root)) return 'unknown';

  // Only the single validated drive literal below reaches the PowerShell filter.
  const deviceId = root.slice(0, 2).toUpperCase();
  const known = cached.get(deviceId);
  if (known !== undefined) return known;
  let type: AssetLibraryDriveType;
  if ((runtime.platform ?? process.platform) !== 'win32') {
    // No removable drives and no network shares to tell apart from here.
    type = 'unknown';
  } else {
    type = await queryWindowsDriveType(deviceId, runtime.execFile ?? execFile);
  }
  cached.set(deviceId, type);
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
